BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE TABLE public.device_employee_mappings (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 device_id uuid NOT NULL,
 employee_id uuid NOT NULL,
 source_user_id varchar(64) COLLATE "C" NOT NULL CHECK (source_user_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 effective_from timestamptz NOT NULL CHECK (effective_from >= '2000-01-01T00:00:00Z'::timestamptz AND effective_from < '2100-01-01T00:00:00Z'::timestamptz),
 effective_until timestamptz CHECK (effective_until > effective_from AND effective_until < '2100-01-01T00:00:00Z'::timestamptz),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,device_id) REFERENCES public.attendance_devices(tenant_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,employee_id) REFERENCES public.employees(tenant_id,id) ON DELETE RESTRICT,
 EXCLUDE USING gist (tenant_id WITH =, device_id WITH =, source_user_id WITH =,
  tstzrange(effective_from,effective_until,'[)') WITH &&)
);
CREATE INDEX device_mapping_page ON public.device_employee_mappings(tenant_id,device_id,id);
CREATE TABLE public.device_mapping_receipts (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,
 input jsonb NOT NULL,
 mapping_id uuid NOT NULL,
 mapping_version integer NOT NULL CHECK (mapping_version > 0),
 PRIMARY KEY(tenant_id,actor_id,request_id),
 FOREIGN KEY(tenant_id,mapping_id) REFERENCES public.device_employee_mappings(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE public.device_employee_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_employee_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.device_mapping_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_mapping_receipts FORCE ROW LEVEL SECURITY;
-- No ordinary runtime tenant policy: all access uses constrained functions.
CREATE FUNCTION public.read_tenant_device_mappings(p_actor uuid,p_mfa boolean,p_tenant uuid,p_device uuid,p_limit integer,p_after uuid)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.attendance_devices WHERE tenant_id=p_tenant AND id=p_device) THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN;
 END IF;
 RETURN QUERY SELECT 'ok'::text, coalesce(jsonb_agg(jsonb_build_object(
  'id',m.id,'deviceId',m.device_id,'employeeId',m.employee_id,'sourceUserId',m.source_user_id,
  'effectiveFrom',m.effective_from,'effectiveUntil',m.effective_until,'version',m.version,
  'createdAt',m.created_at,'updatedAt',m.updated_at) ORDER BY m.id),'[]'::jsonb)
 FROM (SELECT * FROM public.device_employee_mappings WHERE tenant_id=p_tenant AND device_id=p_device
  AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1) m;
END $$;
CREATE FUNCTION public.resolve_tenant_device_mapping(p_actor uuid,p_mfa boolean,p_tenant uuid,p_device uuid,p_source varchar,p_at timestamptz)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE matched integer; matches jsonb;
BEGIN
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 IF p_source IS NULL OR p_source !~ '^[A-Za-z0-9_-]{1,64}$' OR p_at IS NULL OR p_at < '2000-01-01T00:00:00Z'::timestamptz OR p_at >= '2100-01-01T00:00:00Z'::timestamptz THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.attendance_devices WHERE tenant_id=p_tenant AND id=p_device) THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN;
 END IF;
 SELECT count(*),jsonb_agg(jsonb_build_object('status','mapped','mappingId',id,'mappingVersion',version,'employeeId',employee_id)) INTO matched,matches
 FROM public.device_employee_mappings WHERE tenant_id=p_tenant AND device_id=p_device AND source_user_id=p_source COLLATE "C"
  AND tstzrange(effective_from,effective_until,'[)') @> p_at;
 IF matched=1 THEN
  RETURN QUERY SELECT 'ok'::text,matches->0;
 ELSE
  RETURN QUERY SELECT 'ok'::text,jsonb_build_object('status',CASE WHEN matched=0 THEN 'unmapped' ELSE 'ambiguous' END,
   'mappingId',NULL,'mappingVersion',NULL,'employeeId',NULL);
 END IF;
END $$;
CREATE FUNCTION public.mutate_tenant_device_mapping(
 p_actor uuid,p_mfa boolean,p_tenant uuid,p_device uuid,p_request uuid,p_mapping uuid,p_expected integer,
 p_employee uuid,p_source varchar,p_from timestamptz,p_until timestamptz,p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome text,resource_id uuid,resource_version integer,replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE existing public.device_employee_mappings%ROWTYPE; receipt public.device_mapping_receipts%ROWTYPE;
 payload jsonb; next_version integer;
BEGIN
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::uuid,NULL::integer,false; RETURN;
 END IF;
 IF p_request IS NULL OR p_mapping IS NULL OR
  (p_expected IS NULL AND (p_employee IS NULL OR p_source IS NULL OR p_source !~ '^[A-Za-z0-9_-]{1,64}$'
   OR p_from IS NULL OR p_from < '2000-01-01T00:00:00Z'::timestamptz OR p_from >= '2100-01-01T00:00:00Z'::timestamptz
   OR (p_until IS NOT NULL AND (p_until <= p_from OR p_until >= '2100-01-01T00:00:00Z'::timestamptz)) OR p_reason IS DISTINCT FROM 'initial_mapping')) OR
  (p_expected IS NOT NULL AND (p_expected NOT BETWEEN 1 AND 2147483646 OR p_employee IS NOT NULL OR p_source IS NOT NULL
   OR p_from IS NOT NULL OR p_until IS NULL OR p_until < '2000-01-01T00:00:00Z'::timestamptz OR p_until >= '2100-01-01T00:00:00Z'::timestamptz OR p_reason IS DISTINCT FROM 'end_mapping')) THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::uuid,NULL::integer,false; RETURN;
 END IF;
 -- Shared inventory lock prevents creation racing with retirement; also serializes exact-request replay.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':attendance_devices',0));
 payload:=jsonb_build_object('device',p_device,'expected',p_expected,'mapping',CASE WHEN p_expected IS NULL THEN NULL ELSE p_mapping END,
  'employee',p_employee,'source',p_source,'from',extract(epoch from p_from),'until',extract(epoch from p_until),'reason',p_reason);
 SELECT * INTO receipt FROM public.device_mapping_receipts WHERE tenant_id=p_tenant AND actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF receipt.input IS DISTINCT FROM payload THEN RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer,false; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::text,receipt.mapping_id,receipt.mapping_version,true; RETURN;
 END IF;
 PERFORM 1 FROM public.attendance_devices WHERE tenant_id=p_tenant AND id=p_device FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::uuid,NULL::integer,false; RETURN; END IF;
 IF p_expected IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.attendance_devices WHERE tenant_id=p_tenant AND id=p_device AND status<>'draft') THEN
   RETURN QUERY SELECT 'invalid_state'::text,NULL::uuid,NULL::integer,false; RETURN;
  END IF;
  PERFORM 1 FROM public.employees WHERE tenant_id=p_tenant AND id=p_employee AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::uuid,NULL::integer,false; RETURN; END IF;
  IF EXISTS(SELECT 1 FROM public.device_employee_mappings WHERE tenant_id=p_tenant AND device_id=p_device
   AND source_user_id=p_source COLLATE "C" AND tstzrange(effective_from,effective_until,'[)') && tstzrange(p_from,p_until,'[)')) THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer,false; RETURN;
  END IF;
  INSERT INTO public.device_employee_mappings(id,tenant_id,device_id,employee_id,source_user_id,effective_from,effective_until)
   VALUES(p_mapping,p_tenant,p_device,p_employee,p_source,p_from,p_until);
  next_version:=1;
 ELSE
  SELECT * INTO existing FROM public.device_employee_mappings WHERE tenant_id=p_tenant AND device_id=p_device AND id=p_mapping FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::uuid,NULL::integer,false; RETURN; END IF;
  IF existing.version<>p_expected THEN RETURN QUERY SELECT 'stale'::text,NULL::uuid,NULL::integer,false; RETURN; END IF;
  IF p_until<=existing.effective_from OR (existing.effective_until IS NOT NULL AND p_until>=existing.effective_until) THEN
   RETURN QUERY SELECT 'invalid_state'::text,NULL::uuid,NULL::integer,false; RETURN;
  END IF;
  next_version:=existing.version+1;
  UPDATE public.device_employee_mappings SET effective_until=p_until,version=next_version,updated_at=now() WHERE id=p_mapping AND tenant_id=p_tenant;
 END IF;
 INSERT INTO public.device_mapping_receipts(tenant_id,actor_id,request_id,input,mapping_id,mapping_version)
  VALUES(p_tenant,p_actor,p_request,payload,p_mapping,next_version);
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
  VALUES(p_audit,p_tenant,p_actor,CASE WHEN p_expected IS NULL THEN 'device.mapping_created' ELSE 'device.mapping_ended' END,p_reason,p_mapping);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
  VALUES(p_outbox,p_tenant,'device.mapping_changed.v1',p_mapping,next_version);
 RETURN QUERY SELECT 'ok'::text,p_mapping,next_version,false;
END $$;
REVOKE ALL ON public.device_employee_mappings,public.device_mapping_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_tenant_device_mappings(uuid,boolean,uuid,uuid,integer,uuid),
 public.resolve_tenant_device_mapping(uuid,boolean,uuid,uuid,varchar,timestamptz),
 public.mutate_tenant_device_mapping(uuid,boolean,uuid,uuid,uuid,uuid,integer,uuid,varchar,timestamptz,timestamptz,varchar,uuid,uuid) FROM PUBLIC;
COMMIT;
