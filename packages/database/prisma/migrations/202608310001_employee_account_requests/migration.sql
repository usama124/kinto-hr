BEGIN;

-- Record administrator-approved employee access without creating a provider
-- identity or membership. Provider delivery is a later bounded slice.
CREATE TABLE employee_account_requests (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  requested_by_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  email varchar(320) NOT NULL CHECK (
    length(email) BETWEEN 3 AND 320 AND email = lower(email)
  ),
  status varchar(40) NOT NULL DEFAULT 'pending_identity_provider' CHECK (
    status IN (
      'pending_identity_provider', 'pending_delivery', 'pending_activation',
      'active', 'failed', 'revoked'
    )
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, employee_id)
    REFERENCES employees(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, request_key),
  UNIQUE (tenant_id, employee_id)
);
ALTER TABLE employee_account_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_account_requests FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.request_employee_account_provisioning(
  p_actor_id uuid,
  p_mfa_verified boolean,
  p_tenant_id uuid,
  p_employee_id uuid,
  p_request_key uuid,
  p_request_id uuid,
  p_audit_id uuid,
  p_email varchar
) RETURNS TABLE (
  outcome text,
  account_request_id uuid,
  provisioning_status varchar
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing record;
BEGIN
  IF NOT p_mfa_verified OR NOT EXISTS (
    SELECT 1
      FROM public.identities i
      JOIN public.memberships m ON m.identity_id = i.id
      JOIN public.tenants t ON t.id = m.tenant_id
     WHERE i.id = p_actor_id
       AND i.status = 'active'
       AND m.tenant_id = p_tenant_id
       AND m.status = 'active'
       AND m.roles && ARRAY['owner', 'hr_admin']::text[]
       AND t.status = 'active'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::varchar;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.employees
     WHERE tenant_id = p_tenant_id
       AND id = p_employee_id
       AND status IN ('draft', 'active')
  ) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::varchar;
    RETURN;
  END IF;

  -- Serialize all account requests for one employee, including different keys.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id::text || ':' || p_employee_id::text,
      0
    )
  );

  SELECT id, employee_id, requested_by_identity_id, email, status
    INTO v_existing
    FROM public.employee_account_requests
   WHERE tenant_id = p_tenant_id AND request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.employee_id IS DISTINCT FROM p_employee_id
       OR v_existing.requested_by_identity_id IS DISTINCT FROM p_actor_id
       OR v_existing.email IS DISTINCT FROM p_email THEN
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::varchar;
    ELSE
      RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.status;
    END IF;
    RETURN;
  END IF;

  SELECT id, email, status INTO v_existing
    FROM public.employee_account_requests
   WHERE tenant_id = p_tenant_id AND employee_id = p_employee_id;
  IF FOUND THEN
    IF v_existing.email IS DISTINCT FROM p_email THEN
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::varchar;
    ELSE
      RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.status;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.employee_account_requests(
    id, request_key, tenant_id, employee_id, requested_by_identity_id, email
  ) VALUES (
    p_request_id, p_request_key, p_tenant_id, p_employee_id, p_actor_id, p_email
  );
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, resource_id)
  VALUES (p_audit_id, p_tenant_id, p_actor_id,
    'employee.account_provisioning_requested', p_employee_id);

  RETURN QUERY SELECT 'created'::text, p_request_id,
    'pending_identity_provider'::varchar;
END;
$$;
REVOKE ALL ON FUNCTION public.request_employee_account_provisioning(
  uuid, boolean, uuid, uuid, uuid, uuid, uuid, varchar
) FROM PUBLIC;

COMMIT;
