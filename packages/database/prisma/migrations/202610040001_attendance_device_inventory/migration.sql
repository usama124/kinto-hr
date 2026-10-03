BEGIN;
-- Inventory only. No active status, adapter approval, credentials or ingest grant.
CREATE TABLE public.attendance_devices (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 branch_id uuid NOT NULL,
 code varchar(20) NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
 name varchar(160) NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
 model varchar(20) NOT NULL CHECK (model='ZKTeco_K50'),
 firmware varchar(64) CHECK (firmware ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$'),
 source_timezone varchar(64) NOT NULL CHECK (source_timezone='Asia/Karachi'),
 status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','retired')),
 version integer NOT NULL DEFAULT 1 CHECK (version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,code),
 FOREIGN KEY(tenant_id,branch_id) REFERENCES public.branches(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE public.attendance_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.attendance_devices
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION public.read_tenant_device_inventory(p_actor uuid,p_mfa boolean,p_tenant uuid,p_limit integer,p_after uuid)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
 END IF;
 RETURN QUERY SELECT 'ok'::text,coalesce(jsonb_agg(jsonb_build_object(
  'id',d.id,'branchId',d.branch_id,'code',d.code,'name',d.name,'model',d.model,
  'firmware',d.firmware,'sourceTimezone',d.source_timezone,'status',d.status,'version',d.version,
  'adapterVersion',NULL,'sourceIdentityStatus','unverified','health','not_connected','lastSyncAt',NULL,
  'createdAt',d.created_at,'updatedAt',d.updated_at) ORDER BY d.id),'[]'::jsonb)
 FROM (SELECT * FROM public.attendance_devices WHERE tenant_id=p_tenant AND (p_after IS NULL OR id>p_after)
  ORDER BY id LIMIT p_limit+1) d;
END $$;
CREATE FUNCTION public.mutate_tenant_device_inventory(
 p_actor uuid,p_mfa boolean,p_tenant uuid,p_device uuid,p_expected integer,
 p_branch uuid,p_code varchar,p_name varchar,p_model varchar,p_firmware varchar,p_timezone varchar,
 p_status varchar,p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome text,resource_id uuid,resource_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE existing public.attendance_devices%ROWTYPE; next_version integer;
BEGIN
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF NOT public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 IF p_branch IS NULL OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 160 OR
  p_model IS DISTINCT FROM 'ZKTeco_K50' OR p_timezone IS DISTINCT FROM 'Asia/Karachi' OR
  (p_firmware IS NOT NULL AND p_firmware !~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$') OR
  p_status IS NULL OR p_status NOT IN ('draft','retired') OR p_reason IS NULL OR
  (p_expected IS NULL AND (p_status<>'draft' OR p_reason<>'initial_setup' OR p_code IS NULL OR p_code !~ '^[A-Z0-9][A-Z0-9_-]{0,19}$')) OR
  (p_expected IS NOT NULL AND (p_expected NOT BETWEEN 1 AND 2147483646 OR p_code IS NOT NULL OR
    NOT ((p_status='draft' AND p_reason='metadata_correction') OR (p_status='retired' AND p_reason='retire_device')))) THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 -- Serialize creation by tenant/code; lock order is stable across all inventory writes.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':attendance_devices',0));
 IF p_expected IS NULL THEN
  IF EXISTS(SELECT 1 FROM public.attendance_devices WHERE tenant_id=p_tenant AND code=p_code) THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer; RETURN;
  END IF;
 ELSE
  SELECT * INTO existing FROM public.attendance_devices WHERE tenant_id=p_tenant AND id=p_device FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::uuid,NULL::integer; RETURN; END IF;
  IF existing.version<>p_expected THEN RETURN QUERY SELECT 'stale'::text,NULL::uuid,NULL::integer; RETURN; END IF;
  IF existing.status='retired' THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::uuid,NULL::integer; RETURN; END IF;
  IF p_status='retired' AND (existing.branch_id<>p_branch OR existing.name<>btrim(p_name) OR
   existing.model<>p_model OR existing.firmware IS DISTINCT FROM p_firmware OR existing.source_timezone<>p_timezone) THEN
   RETURN QUERY SELECT 'invalid_state'::text,NULL::uuid,NULL::integer; RETURN;
  END IF;
  IF p_status='draft' AND existing.branch_id=p_branch AND existing.name=btrim(p_name) AND
   existing.firmware IS NOT DISTINCT FROM p_firmware THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer; RETURN;
  END IF;
 END IF;
 -- Prevent an inactive/cross-tenant branch assignment. Retirement may retain an inactive historical branch.
 PERFORM 1 FROM public.branches WHERE tenant_id=p_tenant AND id=p_branch AND (status='active' OR p_status='retired') FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::uuid,NULL::integer; RETURN; END IF;
 IF p_expected IS NULL THEN
  INSERT INTO public.attendance_devices(id,tenant_id,branch_id,code,name,model,firmware,source_timezone)
   VALUES(p_device,p_tenant,p_branch,p_code,btrim(p_name),p_model,p_firmware,p_timezone);
  next_version:=1;
 ELSE
  next_version:=existing.version+1;
  UPDATE public.attendance_devices SET branch_id=p_branch,name=btrim(p_name),firmware=p_firmware,
   status=p_status,version=next_version,updated_at=now() WHERE tenant_id=p_tenant AND id=p_device;
 END IF;
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
  VALUES(p_audit,p_tenant,p_actor,CASE WHEN p_expected IS NULL THEN 'device.registered' WHEN p_status='retired' THEN 'device.retired' ELSE 'device.metadata_updated' END,p_reason,p_device);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
  VALUES(p_outbox,p_tenant,'device.inventory_changed.v1',p_device,next_version);
 RETURN QUERY SELECT CASE WHEN p_expected IS NULL THEN 'created' ELSE 'updated' END,p_device,next_version;
END $$;
REVOKE ALL ON public.attendance_devices FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_tenant_device_inventory(uuid,boolean,uuid,integer,uuid),
 public.mutate_tenant_device_inventory(uuid,boolean,uuid,uuid,integer,uuid,varchar,varchar,varchar,varchar,varchar,varchar,varchar,uuid,uuid) FROM PUBLIC;
COMMIT;
