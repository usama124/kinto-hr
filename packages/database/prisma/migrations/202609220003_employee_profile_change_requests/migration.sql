BEGIN;

CREATE TABLE public.employee_profile_change_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  requested_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  expected_contact_version integer NOT NULL CHECK (expected_contact_version>=0),
  personal_email varchar(320),
  mobile_phone varchar(16),
  emergency_contact_name varchar(160),
  emergency_contact_phone varchar(16),
  reason varchar(240) NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 240),
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,request_key),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES public.employees(tenant_id,id) ON DELETE RESTRICT,
  CHECK (personal_email IS NULL OR (personal_email=lower(personal_email) AND length(personal_email) BETWEEN 3 AND 320)),
  CHECK (mobile_phone IS NULL OR mobile_phone ~ '^\+?[0-9]{7,15}$'),
  CHECK (emergency_contact_phone IS NULL OR emergency_contact_phone ~ '^\+?[0-9]{7,15}$'),
  CHECK ((emergency_contact_name IS NULL) = (emergency_contact_phone IS NULL))
);
CREATE UNIQUE INDEX employee_profile_change_one_pending_idx
  ON public.employee_profile_change_requests(tenant_id,employee_id) WHERE status='pending';
CREATE INDEX employee_profile_change_employee_created_idx
  ON public.employee_profile_change_requests(tenant_id,employee_id,created_at DESC);
ALTER TABLE public.employee_profile_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_profile_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.employee_profile_change_requests
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION public.employee_profile_change_request_json(
  p_request public.employee_profile_change_requests
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'id',p_request.id,'status',p_request.status,
    'expectedContactVersion',p_request.expected_contact_version,
    'personalEmail',p_request.personal_email,'mobilePhone',p_request.mobile_phone,
    'emergencyContactName',p_request.emergency_contact_name,
    'emergencyContactPhone',p_request.emergency_contact_phone,
    'reason',p_request.reason,'createdAt',p_request.created_at
  )
$$;

CREATE FUNCTION public.submit_tenant_self_profile_change_request(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_request uuid,p_request_key uuid,
  p_request_digest varchar,p_expected_version integer,p_personal_email varchar,
  p_mobile_phone varchar,p_emergency_name varchar,p_emergency_phone varchar,
  p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_employee uuid;
  v_status varchar;
  current_details public.employee_private_details%ROWTYPE;
  existing public.employee_profile_change_requests%ROWTYPE;
  created public.employee_profile_change_requests%ROWTYPE;
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
  IF p_request_digest !~ '^[a-f0-9]{64}$' OR p_expected_version<0
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240
    OR (p_personal_email IS NOT NULL AND (p_personal_email<>lower(p_personal_email) OR length(p_personal_email) NOT BETWEEN 3 AND 320))
    OR (p_mobile_phone IS NOT NULL AND p_mobile_phone !~ '^\+?[0-9]{7,15}$')
    OR (p_emergency_phone IS NOT NULL AND p_emergency_phone !~ '^\+?[0-9]{7,15}$')
    OR ((p_emergency_name IS NULL) <> (p_emergency_phone IS NULL))
    OR (p_emergency_name IS NOT NULL AND length(btrim(p_emergency_name)) NOT BETWEEN 1 AND 160) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT e.status INTO v_status FROM public.employees e
    WHERE e.tenant_id=p_tenant AND e.id=v_employee FOR UPDATE;
  IF NOT FOUND OR v_status NOT IN ('draft','active') THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT r.* INTO existing FROM public.employee_profile_change_requests r
    WHERE r.tenant_id=p_tenant AND r.request_key=p_request_key;
  IF FOUND THEN
    IF existing.employee_id<>v_employee OR existing.request_digest<>p_request_digest THEN
      RETURN QUERY SELECT 'conflict'::varchar,NULL::jsonb; RETURN;
    END IF;
    RETURN QUERY SELECT 'submitted'::varchar,public.employee_profile_change_request_json(existing); RETURN;
  END IF;
  SELECT d.* INTO current_details FROM public.employee_private_details d
    WHERE d.tenant_id=p_tenant AND d.employee_id=v_employee;
  IF COALESCE(current_details.version,0)<>p_expected_version THEN
    RETURN QUERY SELECT 'stale'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_personal_email IS NOT DISTINCT FROM current_details.personal_email
    AND p_mobile_phone IS NOT DISTINCT FROM current_details.mobile_phone
    AND p_emergency_name IS NOT DISTINCT FROM current_details.emergency_contact_name
    AND p_emergency_phone IS NOT DISTINCT FROM current_details.emergency_contact_phone THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.employee_profile_change_requests r
    WHERE r.tenant_id=p_tenant AND r.employee_id=v_employee AND r.status='pending') THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  INSERT INTO public.employee_profile_change_requests(
    id,tenant_id,employee_id,requested_by_identity_id,request_key,request_digest,
    expected_contact_version,personal_email,mobile_phone,
    emergency_contact_name,emergency_contact_phone,reason
  ) VALUES (
    p_request,p_tenant,v_employee,p_actor,p_request_key,p_request_digest,
    p_expected_version,p_personal_email,p_mobile_phone,p_emergency_name,
    p_emergency_phone,btrim(p_reason)
  ) RETURNING * INTO created;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.profile_change_requested',
      'Employee requested contact change',p_request);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.profile_change_requested.v1',p_request,1);
  RETURN QUERY SELECT 'submitted'::varchar,public.employee_profile_change_request_json(created);
END $$;

CREATE FUNCTION public.read_tenant_self_profile_change_requests(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_employee uuid;
BEGIN
  IF NOT p_mfa_verified THEN RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN; END IF;
  SELECT l.employee_id INTO v_employee
  FROM public.employee_identity_links l
  JOIN public.memberships m ON m.id=l.membership_id AND m.tenant_id=l.tenant_id
  JOIN public.identities i ON i.id=l.identity_id
  JOIN public.tenants t ON t.id=l.tenant_id
  JOIN public.employees e ON e.tenant_id=l.tenant_id AND e.id=l.employee_id
  WHERE l.tenant_id=p_tenant AND l.identity_id=p_actor AND m.identity_id=p_actor
    AND i.status='active' AND t.status='active' AND m.status='active'
    AND m.roles @> ARRAY['employee']::text[] AND e.status IN ('draft','active');
  IF NOT FOUND THEN RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::varchar,jsonb_build_object('requests',COALESCE((
    SELECT jsonb_agg(public.employee_profile_change_request_json(r) ORDER BY r.created_at DESC,r.id DESC)
    FROM (SELECT * FROM public.employee_profile_change_requests WHERE tenant_id=p_tenant
      AND employee_id=v_employee ORDER BY created_at DESC,id DESC LIMIT 100) r
  ),'[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION public.employee_profile_change_request_json(public.employee_profile_change_requests) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_tenant_self_profile_change_request(uuid,boolean,uuid,uuid,uuid,varchar,integer,varchar,varchar,varchar,varchar,varchar,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_tenant_self_profile_change_requests(uuid,boolean,uuid) FROM PUBLIC;

COMMIT;
