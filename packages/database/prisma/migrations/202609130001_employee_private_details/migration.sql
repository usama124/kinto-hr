BEGIN;

CREATE TABLE public.employee_private_details (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  personal_email varchar(320),
  mobile_phone varchar(16),
  residential_address varchar(500),
  emergency_contact_name varchar(160),
  emergency_contact_phone varchar(16),
  cnic varchar(13),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES public.employees(tenant_id, id) ON DELETE RESTRICT,
  CHECK (personal_email IS NULL OR (personal_email=lower(personal_email) AND length(personal_email) BETWEEN 3 AND 320)),
  CHECK (mobile_phone IS NULL OR mobile_phone ~ '^\+?[0-9]{7,15}$'),
  CHECK (emergency_contact_phone IS NULL OR emergency_contact_phone ~ '^\+?[0-9]{7,15}$'),
  CHECK ((emergency_contact_name IS NULL) = (emergency_contact_phone IS NULL)),
  CHECK (cnic IS NULL OR cnic ~ '^[0-9]{13}$'),
  CHECK (personal_email IS NOT NULL OR mobile_phone IS NOT NULL OR residential_address IS NOT NULL OR emergency_contact_name IS NOT NULL OR cnic IS NOT NULL)
);

ALTER TABLE public.employee_private_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_private_details FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.employee_private_details
  USING (tenant_id=nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION public.tenant_employee_private_authorized(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_permission varchar
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog, public AS $$
  SELECT p_mfa_verified
    AND p_permission IN ('employees.private.read', 'employees.private.write')
    AND EXISTS (
      SELECT 1 FROM public.tenants t
      JOIN public.memberships m ON m.tenant_id=t.id
      JOIN public.identities i ON i.id=m.identity_id
      WHERE t.id=p_tenant AND t.status='active' AND i.id=p_actor
        AND i.status='active' AND m.status='active'
        AND m.roles && ARRAY['owner','hr_admin']::text[]
    )
$$;

CREATE FUNCTION public.read_tenant_employee_private_details(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid
) RETURNS TABLE(outcome varchar, snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public AS $$
DECLARE details jsonb;
BEGIN
  IF NOT public.tenant_employee_private_authorized(
    p_actor, p_mfa_verified, p_tenant, 'employees.private.read'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::jsonb; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant
    AND e.id=p_employee AND e.joining_date IS NOT NULL) THEN
    RETURN QUERY SELECT 'not_found'::varchar, NULL::jsonb; RETURN;
  END IF;
  SELECT jsonb_build_object(
    'id', d.id,
    'version', d.version,
    'personalEmail', d.personal_email,
    'mobilePhone', d.mobile_phone,
    'residentialAddress', d.residential_address,
    'emergencyContactName', d.emergency_contact_name,
    'emergencyContactPhone', d.emergency_contact_phone,
    'cnic', d.cnic,
    'updatedAt', d.updated_at
  ) INTO details
  FROM public.employee_private_details d
  WHERE d.tenant_id=p_tenant AND d.employee_id=p_employee;
  RETURN QUERY SELECT 'ok'::varchar, jsonb_build_object('details', details);
END $$;

CREATE FUNCTION public.update_tenant_employee_private_details(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid,
  p_details uuid, p_expected_version integer, p_personal_email varchar,
  p_mobile_phone varchar, p_residential_address varchar,
  p_emergency_contact_name varchar, p_emergency_contact_phone varchar,
  p_cnic varchar, p_reason varchar, p_audit uuid, p_outbox uuid
) RETURNS TABLE(outcome varchar, details_id uuid, details_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public AS $$
DECLARE current_details public.employee_private_details%ROWTYPE;
  next_version integer;
  action_name varchar;
  result_details_id uuid;
BEGIN
  IF NOT public.tenant_employee_private_authorized(
    p_actor, p_mfa_verified, p_tenant, 'employees.private.write'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_expected_version < 0 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 OR
     (p_personal_email IS NOT NULL AND (p_personal_email<>lower(p_personal_email) OR length(p_personal_email) NOT BETWEEN 3 AND 320)) OR
     (p_mobile_phone IS NOT NULL AND p_mobile_phone !~ '^\+?[0-9]{7,15}$') OR
     (p_emergency_contact_phone IS NOT NULL AND p_emergency_contact_phone !~ '^\+?[0-9]{7,15}$') OR
     ((p_emergency_contact_name IS NULL) <> (p_emergency_contact_phone IS NULL)) OR
     (p_residential_address IS NOT NULL AND length(btrim(p_residential_address)) NOT BETWEEN 1 AND 500) OR
     (p_emergency_contact_name IS NOT NULL AND length(btrim(p_emergency_contact_name)) NOT BETWEEN 1 AND 160) OR
     (p_cnic IS NOT NULL AND p_cnic !~ '^[0-9]{13}$') OR
     (p_personal_email IS NULL AND p_mobile_phone IS NULL AND p_residential_address IS NULL
       AND p_emergency_contact_name IS NULL AND p_cnic IS NULL) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant
    AND e.id=p_employee AND e.joining_date IS NOT NULL) THEN
    RETURN QUERY SELECT 'not_found'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant
    AND e.id=p_employee AND e.status IN ('draft','active')) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT d.* INTO current_details FROM public.employee_private_details d
    WHERE d.tenant_id=p_tenant AND d.employee_id=p_employee FOR UPDATE;
  IF p_expected_version=0 THEN
    IF FOUND THEN
      RETURN QUERY SELECT 'stale'::varchar, NULL::uuid, NULL::integer; RETURN;
    END IF;
    INSERT INTO public.employee_private_details(
      id, tenant_id, employee_id, personal_email, mobile_phone,
      residential_address, emergency_contact_name, emergency_contact_phone,
      cnic, updated_by_identity_id
    ) VALUES (
      p_details, p_tenant, p_employee, p_personal_email, p_mobile_phone,
      p_residential_address, p_emergency_contact_name,
      p_emergency_contact_phone, p_cnic, p_actor
    );
    next_version := 1;
    result_details_id := p_details;
    action_name := 'employee.private_details_created';
  ELSE
    IF NOT FOUND OR current_details.version<>p_expected_version THEN
      RETURN QUERY SELECT 'stale'::varchar, NULL::uuid, NULL::integer; RETURN;
    END IF;
    next_version := current_details.version+1;
    UPDATE public.employee_private_details d SET
      personal_email=p_personal_email,
      mobile_phone=p_mobile_phone,
      residential_address=p_residential_address,
      emergency_contact_name=p_emergency_contact_name,
      emergency_contact_phone=p_emergency_contact_phone,
      cnic=p_cnic,
      version=next_version,
      updated_by_identity_id=p_actor,
      updated_at=now()
    WHERE d.tenant_id=p_tenant AND d.employee_id=p_employee;
    result_details_id := current_details.id;
    action_name := 'employee.private_details_updated';
  END IF;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit, p_tenant, p_actor, action_name, btrim(p_reason), p_employee);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox, p_tenant, 'employee.private_details_changed.v1', p_employee, next_version);
  RETURN QUERY SELECT 'updated'::varchar, result_details_id, next_version;
END $$;

REVOKE ALL ON FUNCTION public.tenant_employee_private_authorized(uuid, boolean, uuid, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_tenant_employee_private_details(uuid, boolean, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_tenant_employee_private_details(uuid, boolean, uuid, uuid, uuid, integer, varchar, varchar, varchar, varchar, varchar, varchar, varchar, uuid, uuid) FROM PUBLIC;

COMMIT;
