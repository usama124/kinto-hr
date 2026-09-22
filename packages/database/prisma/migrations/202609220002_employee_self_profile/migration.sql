BEGIN;

CREATE FUNCTION public.read_tenant_self_employee_profile(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_employee uuid;
  profile jsonb;
BEGIN
  IF NOT p_mfa_verified THEN RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN; END IF;
  SELECT l.employee_id INTO v_employee
  FROM public.employee_identity_links l
  JOIN public.memberships m ON m.id=l.membership_id AND m.tenant_id=l.tenant_id
  JOIN public.identities i ON i.id=l.identity_id
  JOIN public.tenants t ON t.id=l.tenant_id
  WHERE l.tenant_id=p_tenant AND l.identity_id=p_actor AND m.identity_id=p_actor
    AND i.status='active' AND t.status='active' AND m.status='active'
    AND m.roles @> ARRAY['employee']::text[];
  IF NOT FOUND THEN RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN; END IF;
  SELECT jsonb_build_object(
    'employee',jsonb_build_object(
      'id',e.id,'employeeNumber',e.employee_number,'name',e.name,
      'legalName',e.legal_name,'status',e.status,
      'joiningDate',to_char(e.joining_date,'YYYY-MM-DD')),
    'contact',CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
      'version',d.version,'personalEmail',d.personal_email,
      'mobilePhone',d.mobile_phone,
      'emergencyContactName',d.emergency_contact_name,
      'emergencyContactPhone',d.emergency_contact_phone
    ) END
  ) INTO profile
  FROM public.employees e
  LEFT JOIN public.employee_private_details d
    ON d.tenant_id=e.tenant_id AND d.employee_id=e.id
  WHERE e.tenant_id=p_tenant AND e.id=v_employee AND e.status IN ('draft','active')
    AND e.joining_date IS NOT NULL;
  IF NOT FOUND THEN RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::varchar,profile;
END $$;

REVOKE ALL ON FUNCTION public.read_tenant_self_employee_profile(uuid,boolean,uuid) FROM PUBLIC;

COMMIT;
