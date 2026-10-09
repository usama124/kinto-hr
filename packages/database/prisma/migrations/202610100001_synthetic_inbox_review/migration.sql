BEGIN;
-- Read-only fixture authority. No live admission, promotion or reprocessing.
CREATE FUNCTION public.read_synthetic_attendance_events(
 p_actor uuid,p_mfa boolean,p_tenant uuid,p_device uuid,p_limit integer,p_after uuid
) RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF current_database() !~ '^kinto_test([_a-zA-Z0-9]*)$' OR
  public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.attendance_devices WHERE tenant_id=p_tenant AND id=p_device) THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN;
 END IF;
 RETURN QUERY SELECT 'ok'::text,coalesce(jsonb_agg(jsonb_build_object(
  'id',e.id,'deviceId',e.device_id,'payload',e.payload,'quarantineCode',e.quarantine_code,'createdAt',e.created_at
 ) ORDER BY e.id),'[]'::jsonb)
 FROM (SELECT * FROM public.synthetic_attendance_events WHERE tenant_id=p_tenant AND device_id=p_device
  AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1) e;
END $$;
CREATE FUNCTION public.preview_synthetic_attendance_mapping(
 p_actor uuid,p_mfa boolean,p_tenant uuid,p_device uuid,p_event uuid,p_at timestamptz
) RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE raw public.synthetic_attendance_events%ROWTYPE; matched integer; matches jsonb;
BEGIN
 IF current_database() !~ '^kinto_test([_a-zA-Z0-9]*)$' OR
  public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 IF p_at IS NULL OR p_at<'2000-01-01T00:00:00Z'::timestamptz OR p_at>='2100-01-01T00:00:00Z'::timestamptz THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
 END IF;
 SELECT * INTO raw FROM public.synthetic_attendance_events WHERE tenant_id=p_tenant AND device_id=p_device AND id=p_event;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
 -- The source string comes from the persisted raw event, never caller replacement.
 -- Explicit operator time is a what-if preview, not verified device event time.
 SELECT count(*),jsonb_agg(jsonb_build_object('status','mapped','mappingId',id,'mappingVersion',version,'employeeId',employee_id))
 INTO matched,matches FROM public.device_employee_mappings
 WHERE tenant_id=p_tenant AND device_id=p_device AND source_user_id=raw.payload->>'sourceUserId' COLLATE "C"
  AND tstzrange(effective_from,effective_until,'[)') @> p_at;
 RETURN QUERY SELECT 'ok'::text,jsonb_build_object(
  'event',jsonb_build_object('id',raw.id,'deviceId',raw.device_id,'payload',raw.payload,'quarantineCode',raw.quarantine_code,'createdAt',raw.created_at),
  'requestedAt',p_at,'timeBasis','operator_supplied_unverified',
  'sourceIdentityVerified',false,'clockVerified',false,'attendanceProcessingAvailable',false,
  'resolution',CASE WHEN matched=1 THEN matches->0 ELSE jsonb_build_object('status',CASE WHEN matched=0 THEN 'unmapped' ELSE 'ambiguous' END,
   'mappingId',NULL,'mappingVersion',NULL,'employeeId',NULL) END);
END $$;
REVOKE ALL ON FUNCTION public.read_synthetic_attendance_events(uuid,boolean,uuid,uuid,integer,uuid),
 public.preview_synthetic_attendance_mapping(uuid,boolean,uuid,uuid,uuid,timestamptz) FROM PUBLIC;
COMMIT;
