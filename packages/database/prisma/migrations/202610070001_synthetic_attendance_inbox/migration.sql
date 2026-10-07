BEGIN;
-- Deliberately separate from any live attendance or machine credential authority.
CREATE TABLE public.synthetic_attendance_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 device_id uuid NOT NULL, source_key varchar(64), payload jsonb NOT NULL,
 quarantine_code varchar(40) NOT NULL DEFAULT 'source_identity_unverified' CHECK(quarantine_code='source_identity_unverified'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,device_id,id), UNIQUE(tenant_id,device_id,source_key),
 CHECK(source_key IS NULL OR source_key ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY(tenant_id,device_id) REFERENCES public.attendance_devices(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.synthetic_attendance_transports (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 connector_id uuid NOT NULL, connector_event_id uuid NOT NULL, device_id uuid NOT NULL, event_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,connector_id,connector_event_id),
 FOREIGN KEY(tenant_id,device_id,event_id) REFERENCES public.synthetic_attendance_events(tenant_id,device_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.synthetic_attendance_batches (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 connector_id uuid NOT NULL, batch_id uuid NOT NULL, device_id uuid NOT NULL,
 input jsonb NOT NULL, receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,connector_id,batch_id),
 FOREIGN KEY(tenant_id,device_id) REFERENCES public.attendance_devices(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE public.synthetic_attendance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.synthetic_attendance_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.synthetic_attendance_transports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.synthetic_attendance_transports FORCE ROW LEVEL SECURITY;
ALTER TABLE public.synthetic_attendance_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.synthetic_attendance_batches FORCE ROW LEVEL SECURITY;
CREATE FUNCTION public.store_synthetic_attendance_batch(
 p_actor uuid,p_mfa boolean,p_tenant uuid,p_device uuid,p_connector uuid,p_batch uuid,
 p_input jsonb,p_receipt uuid,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prior public.synthetic_attendance_batches%ROWTYPE; existing public.synthetic_attendance_events%ROWTYPE;
 entry jsonb; event_payload jsonb; dispositions jsonb:='[]'::jsonb; result jsonb; event_id uuid;
 idx integer:=0; code text; transport_found boolean;
BEGIN
 IF current_database() !~ '^kinto_test([_a-zA-Z0-9]*)$' THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 IF p_connector IS NULL OR p_batch IS NULL OR p_receipt IS NULL OR
  jsonb_typeof(p_input) IS DISTINCT FROM 'array' THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
 END IF;
 IF jsonb_array_length(p_input) NOT BETWEEN 1 AND 500 OR octet_length(p_input::text)>1000000 THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
 END IF;
 -- Reject injected fields even if the internal TypeScript preflight is bypassed.
 FOR entry IN SELECT value FROM jsonb_array_elements(p_input) LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR (entry->>'index') IS DISTINCT FROM idx::text THEN
   RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
  END IF;
  IF entry->>'state'='candidate' THEN
   event_payload:=entry->'event';
   IF entry - ARRAY['index','state','connectorEventId','event','sourceKey'] <> '{}'::jsonb OR
    jsonb_typeof(event_payload) IS DISTINCT FROM 'object' OR
    event_payload - ARRAY['connectorEventId','sourceUserId','sourceLocalTimestamp','sourceEventId','direction','workCode'] <> '{}'::jsonb OR
    (event_payload->>'connectorEventId') IS DISTINCT FROM (entry->>'connectorEventId') OR
    coalesce(event_payload->>'sourceUserId','') !~ '^[A-Za-z0-9._:-]{1,64}$' OR
    coalesce(event_payload->>'sourceLocalTimestamp','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?$' OR
    (event_payload ? 'sourceEventId' AND coalesce(event_payload->>'sourceEventId','') !~ '^[A-Za-z0-9._:-]{1,128}$') OR
    (event_payload ? 'direction' AND coalesce(event_payload->>'direction','') NOT IN ('in','out')) OR
    (event_payload ? 'workCode' AND coalesce(event_payload->>'workCode','') !~ '^[A-Za-z0-9._:-]{1,32}$') OR
    (entry->>'sourceKey' IS NOT NULL AND entry->>'sourceKey' !~ '^[a-f0-9]{64}$') THEN
    RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
   END IF;
  ELSIF entry->>'state'='rejected_unstored' THEN
   IF entry - ARRAY['index','state','connectorEventId','code'] <> '{}'::jsonb OR
    coalesce(entry->>'code','') NOT IN ('invalid_event','duplicate_transport_id','source_identity_missing','source_identity_conflict') THEN
    RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
   END IF;
  ELSE RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
  END IF;
  IF (entry->>'state'='candidate' OR entry ? 'connectorEventId') AND
   coalesce(entry->>'connectorEventId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
   RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
  END IF;
  idx:=idx+1;
 END LOOP;
 -- Share retirement's lock: no new batch may race retirement. Tenant bounded serialization
 -- makes overlapping batches, transport aliases and receipt replay deterministic.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':attendance_devices',0));
 SELECT * INTO prior FROM public.synthetic_attendance_batches WHERE tenant_id=p_tenant AND connector_id=p_connector AND batch_id=p_batch;
 IF FOUND THEN
  IF prior.device_id IS DISTINCT FROM p_device OR prior.input IS DISTINCT FROM p_input THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text,prior.receipt; RETURN;
 END IF;
 PERFORM 1 FROM public.attendance_devices WHERE tenant_id=p_tenant AND id=p_device AND status='draft' FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_input) LOOP
  IF entry->>'state'='rejected_unstored' THEN dispositions:=dispositions || jsonb_build_array((entry-'state') || jsonb_build_object('disposition','rejected_unstored')); CONTINUE; END IF;
  event_payload:=(entry->'event')-'connectorEventId';
  SELECT e.* INTO existing FROM public.synthetic_attendance_transports t
   JOIN public.synthetic_attendance_events e ON e.tenant_id=t.tenant_id AND e.device_id=t.device_id AND e.id=t.event_id
   WHERE t.tenant_id=p_tenant AND t.connector_id=p_connector AND t.connector_event_id=(entry->>'connectorEventId')::uuid;
  transport_found:=FOUND;
  code:=NULL;
  IF transport_found THEN
   IF existing.device_id<>p_device OR existing.payload IS DISTINCT FROM event_payload OR existing.source_key IS DISTINCT FROM (entry->>'sourceKey') THEN code:='transport_identity_conflict'; END IF;
  ELSE
   SELECT * INTO existing FROM public.synthetic_attendance_events WHERE tenant_id=p_tenant AND device_id=p_device AND source_key=entry->>'sourceKey';
   IF FOUND AND existing.payload IS DISTINCT FROM event_payload THEN code:='source_identity_conflict'; END IF;
  END IF;
  IF code IS NOT NULL THEN
   dispositions:=dispositions || jsonb_build_array(jsonb_build_object('index',entry->'index','disposition','rejected_unstored','connectorEventId',entry->'connectorEventId','code',code));
   CONTINUE;
  END IF;
  IF existing.id IS NULL THEN
   event_id:=gen_random_uuid();
   INSERT INTO public.synthetic_attendance_events(id,tenant_id,device_id,source_key,payload)
    VALUES(event_id,p_tenant,p_device,entry->>'sourceKey',event_payload);
   code:='quarantined';
  ELSE event_id:=existing.id; code:='duplicate'; END IF;
  IF NOT transport_found THEN
   INSERT INTO public.synthetic_attendance_transports(tenant_id,connector_id,connector_event_id,device_id,event_id)
    VALUES(p_tenant,p_connector,(entry->>'connectorEventId')::uuid,p_device,event_id);
  END IF;
  result:=jsonb_build_object('index',entry->'index','disposition',code,'connectorEventId',entry->'connectorEventId');
  IF code='quarantined' THEN result:=result || jsonb_build_object('code','source_identity_unverified'); END IF;
  dispositions:=dispositions || jsonb_build_array(result);
 END LOOP;
 result:=jsonb_build_object('receiptId',p_receipt,'batchId',p_batch,'deviceId',p_device,'schemaVersion',1,'events',dispositions);
 INSERT INTO public.synthetic_attendance_batches(id,tenant_id,connector_id,batch_id,device_id,input,receipt)
  VALUES(p_receipt,p_tenant,p_connector,p_batch,p_device,p_input,result);
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
  VALUES(p_audit,p_tenant,p_actor,'attendance.synthetic_batch_recorded','synthetic_fixture',p_receipt);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
  VALUES(p_outbox,p_tenant,'attendance.synthetic_inbox_changed.v1',p_receipt,1);
 RETURN QUERY SELECT 'ok'::text,result;
END $$;
REVOKE ALL ON public.synthetic_attendance_events,public.synthetic_attendance_transports,public.synthetic_attendance_batches FROM PUBLIC;
REVOKE ALL ON FUNCTION public.store_synthetic_attendance_batch(uuid,boolean,uuid,uuid,uuid,uuid,jsonb,uuid,uuid,uuid) FROM PUBLIC;
COMMIT;
