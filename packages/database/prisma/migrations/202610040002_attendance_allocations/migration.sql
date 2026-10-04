BEGIN;
-- Immutable operator allocation history; no machine credential or device activation.
CREATE TABLE public.attendance_allocations (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,
 expected_version integer NOT NULL CHECK(expected_version BETWEEN 0 AND 2147483646),
 version integer NOT NULL CHECK(version=expected_version+1),
 enabled boolean NOT NULL,
 device_limit integer NOT NULL CHECK(device_limit BETWEEN 0 AND 1000),
 connector_limit integer NOT NULL CHECK(connector_limit BETWEEN 0 AND 1000),
 reason varchar(40) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,version), UNIQUE(tenant_id,actor_id,request_id),
 CHECK((enabled AND device_limit>0 AND connector_limit>0 AND
    ((expected_version=0 AND reason='initial_setup') OR (expected_version>0 AND reason='allocation_change'))) OR
   (NOT enabled AND device_limit=0 AND connector_limit=0 AND expected_version>0 AND reason='disable_attendance'))
);
ALTER TABLE public.attendance_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_allocations FORCE ROW LEVEL SECURITY;
-- No tenant policy: runtime users cannot obtain operator receipts/history via tenant context.
CREATE FUNCTION public.read_attendance_allocation(p_actor uuid,p_mfa boolean,p_tenant uuid,p_platform boolean)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE allocation public.attendance_allocations%ROWTYPE;
BEGIN
 IF p_platform IS NULL OR (p_platform AND public.check_platform_operator_access(p_actor,p_mfa) IS NOT TRUE) OR
   (NOT p_platform AND public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE) THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=p_tenant AND status='active') OR
   public.resolve_tenant_entitlements_at(p_tenant,now(),NULL,NULL,NULL) IS NULL THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN;
 END IF;
 SELECT * INTO allocation FROM public.attendance_allocations WHERE tenant_id=p_tenant ORDER BY version DESC LIMIT 1;
 RETURN QUERY SELECT 'ok'::text,jsonb_build_object('tenantId',p_tenant,'version',coalesce(allocation.version,0),
  'enabled',coalesce(allocation.enabled,false),'deviceLimit',coalesce(allocation.device_limit,0),
  'connectorLimit',coalesce(allocation.connector_limit,0),'configuredAt',allocation.created_at,'machineAccessAvailable',false);
END $$;
CREATE FUNCTION public.change_attendance_allocation(
 p_actor uuid,p_mfa boolean,p_tenant uuid,p_request uuid,p_record uuid,p_expected integer,
 p_enabled boolean,p_devices integer,p_connectors integer,p_reason varchar,p_audit uuid,p_platform_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome text,record_id uuid,record_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE existing public.attendance_allocations%ROWTYPE; current_allocation public.attendance_allocations%ROWTYPE;
BEGIN
 IF public.check_platform_operator_access(p_actor,p_mfa) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=p_tenant AND status='active') OR
   public.resolve_tenant_entitlements_at(p_tenant,now(),NULL,NULL,NULL) IS NULL THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 IF p_request IS NULL OR p_record IS NULL OR p_expected IS NULL OR p_expected NOT BETWEEN 0 AND 2147483646 OR
  p_enabled IS NULL OR p_devices IS NULL OR p_connectors IS NULL OR p_reason IS NULL OR
  p_devices NOT BETWEEN 0 AND 1000 OR p_connectors NOT BETWEEN 0 AND 1000 OR
  NOT ((p_enabled AND p_devices>0 AND p_connectors>0 AND p_reason=CASE WHEN p_expected=0 THEN 'initial_setup' ELSE 'allocation_change' END) OR
    (NOT p_enabled AND p_devices=0 AND p_connectors=0 AND p_expected>0 AND p_reason='disable_attendance')) THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 -- Future reservation/activation paths must share this lock and recheck effective capacity.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':attendance-allocation',0));
 SELECT * INTO existing FROM public.attendance_allocations WHERE tenant_id=p_tenant AND actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF existing.expected_version<>p_expected OR existing.enabled<>p_enabled OR existing.device_limit<>p_devices OR
   existing.connector_limit<>p_connectors OR existing.reason<>p_reason THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer; RETURN;
  END IF;
  RETURN QUERY SELECT 'replayed'::text,existing.id,existing.version; RETURN;
 END IF;
 SELECT * INTO current_allocation FROM public.attendance_allocations WHERE tenant_id=p_tenant ORDER BY version DESC LIMIT 1;
 IF coalesce(current_allocation.version,0)<>p_expected THEN
  RETURN QUERY SELECT 'stale'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 IF current_allocation.version IS NOT NULL AND current_allocation.enabled=p_enabled AND current_allocation.device_limit=p_devices AND current_allocation.connector_limit=p_connectors THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 INSERT INTO public.attendance_allocations(id,tenant_id,actor_id,request_id,expected_version,version,enabled,device_limit,connector_limit,reason)
  VALUES(p_record,p_tenant,p_actor,p_request,p_expected,p_expected+1,p_enabled,p_devices,p_connectors,p_reason);
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
  VALUES(p_audit,p_tenant,p_actor,'attendance.allocation_changed',p_reason,p_record);
 INSERT INTO public.platform_audit_events(id,actor_id,action,resource_id)
  VALUES(p_platform_audit,p_actor,'attendance.allocation_changed',p_tenant);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
  VALUES(p_outbox,p_tenant,'attendance.allocation_changed.v1',p_tenant,p_expected+1);
 RETURN QUERY SELECT 'created'::text,p_record,p_expected+1;
END $$;
REVOKE ALL ON public.attendance_allocations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_attendance_allocation(uuid,boolean,uuid,boolean),
 public.change_attendance_allocation(uuid,boolean,uuid,uuid,uuid,integer,boolean,integer,integer,varchar,uuid,uuid,uuid) FROM PUBLIC;
COMMIT;
