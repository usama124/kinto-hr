BEGIN;
CREATE FUNCTION public.read_platform_entitlement_state(p_actor uuid,p_mfa boolean,p_tenant uuid)
RETURNS TABLE(outcome varchar,payload jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
AS $$
DECLARE v_name varchar; v_effective jsonb; v_history jsonb;
BEGIN
  IF public.check_platform_operator_access(p_actor,p_mfa) IS NOT TRUE THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT name INTO v_name FROM public.tenants WHERE id=p_tenant AND status='active';
  IF v_name IS NULL THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  v_effective:=public.resolve_tenant_entitlements_at(p_tenant,now(),NULL,NULL,NULL);
  IF v_effective IS NULL THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  SELECT coalesce(jsonb_agg(q.item ORDER BY q.created_at DESC,q.id),'[]'::jsonb) INTO v_history FROM (
    SELECT c.id,c.created_at,jsonb_build_object(
      'id',c.id,'kind',c.kind,'changeType',c.change_type,'employeeLimit',c.employee_limit,
      'seatDelta',c.seat_delta,'startsAt',c.starts_at,'endsAt',c.ends_at,
      'status',c.status,'version',c.version,'reason',c.reason,'revokedReason',c.revoked_reason
    ) AS item FROM (
      SELECT id,created_at,'grant'::text kind,kind::text change_type,employee_limit,seat_delta,starts_at,ends_at,status,version,reason,revoked_reason
      FROM public.entitlement_grants WHERE tenant_id=p_tenant
      UNION ALL
      SELECT id,created_at,'override'::text,'employee_limit_override'::text,employee_limit,NULL::integer,starts_at,ends_at,status,version,reason,revoked_reason
      FROM public.entitlement_overrides WHERE tenant_id=p_tenant
    ) c ORDER BY c.created_at DESC,c.id LIMIT 101
  ) q;
  RETURN QUERY SELECT 'ok'::varchar,jsonb_build_object(
    'tenantId',p_tenant,'companyName',v_name,'evaluatedAt',now(),'effective',v_effective,
    'historyTruncated',jsonb_array_length(v_history)>100,
    'controls',(SELECT coalesce(jsonb_agg(e.value ORDER BY e.ordinality),'[]'::jsonb) FROM jsonb_array_elements(v_history) WITH ORDINALITY e WHERE e.ordinality<=100)
  );
END $$;
REVOKE ALL ON FUNCTION public.read_platform_entitlement_state(uuid,boolean,uuid) FROM PUBLIC;
COMMIT;
