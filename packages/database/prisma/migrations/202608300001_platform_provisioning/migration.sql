BEGIN;

-- Platform authority is deliberately separate from customer memberships.
CREATE TABLE platform_operators (
  identity_id uuid PRIMARY KEY REFERENCES identities(id) ON DELETE RESTRICT,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_operators FORCE ROW LEVEL SECURITY;

-- This durable request remains denied until a later identity-provider worker
-- creates and verifies the intended owner and activates its invitation.
CREATE TABLE company_provisioning_requests (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL,
  requested_by_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
  initial_owner_email varchar(320) NOT NULL CHECK (
    length(initial_owner_email) BETWEEN 3 AND 320 AND
    initial_owner_email = lower(initial_owner_email)
  ),
  status varchar(40) NOT NULL DEFAULT 'pending_identity_provider' CHECK (
    status IN ('pending_identity_provider', 'pending_activation', 'active', 'failed', 'revoked')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (requested_by_identity_id, request_key)
);
ALTER TABLE company_provisioning_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_provisioning_requests FORCE ROW LEVEL SECURITY;

-- Tenant audit cannot represent first-operator bootstrap, so control-plane
-- security actions also have a global append-only audit stream.
CREATE TABLE platform_audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  action varchar(100) NOT NULL,
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_events_created_at_idx ON platform_audit_events(created_at);
ALTER TABLE platform_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_events FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.request_company_provisioning(
  p_actor_id uuid,
  p_mfa_verified boolean,
  p_request_key uuid,
  p_tenant_id uuid,
  p_request_id uuid,
  p_tenant_audit_id uuid,
  p_platform_audit_id uuid,
  p_company_name varchar,
  p_employee_limit integer,
  p_billing_mode varchar,
  p_initial_owner_email varchar
) RETURNS TABLE (
  outcome text,
  tenant_id uuid,
  provisioning_request_id uuid,
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
      JOIN public.platform_operators o ON o.identity_id = i.id
     WHERE i.id = p_actor_id AND i.status = 'active' AND o.status = 'active'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::uuid, NULL::varchar;
    RETURN;
  END IF;

  -- Serialize a caller's retries so a repeated key cannot create orphan tenants.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_actor_id::text || ':' || p_request_key::text, 0)
  );

  SELECT r.id, r.tenant_id, r.initial_owner_email, r.status,
         t.name, t.employee_limit, t.billing_mode
    INTO v_existing
    FROM public.company_provisioning_requests r
    JOIN public.tenants t ON t.id = r.tenant_id
   WHERE r.requested_by_identity_id = p_actor_id
     AND r.request_key = p_request_key;

  IF FOUND THEN
    IF v_existing.name IS DISTINCT FROM p_company_name
       OR v_existing.employee_limit IS DISTINCT FROM p_employee_limit
       OR v_existing.billing_mode IS DISTINCT FROM p_billing_mode
       OR v_existing.initial_owner_email IS DISTINCT FROM p_initial_owner_email THEN
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::uuid, NULL::varchar;
    ELSE
      RETURN QUERY SELECT 'existing'::text, v_existing.tenant_id,
        v_existing.id, v_existing.status;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.tenants(id, name, employee_limit, billing_mode)
  VALUES (p_tenant_id, p_company_name, p_employee_limit, p_billing_mode);
  INSERT INTO public.company_provisioning_requests(
    id, request_key, requested_by_identity_id, tenant_id, initial_owner_email
  ) VALUES (
    p_request_id, p_request_key, p_actor_id, p_tenant_id, p_initial_owner_email
  );
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, resource_id)
  VALUES (p_tenant_audit_id, p_tenant_id, p_actor_id,
    'company.provisioning_requested', p_request_id);
  INSERT INTO public.platform_audit_events(id, actor_id, action, resource_id)
  VALUES (p_platform_audit_id, p_actor_id,
    'company.provisioning_requested', p_tenant_id);

  RETURN QUERY SELECT 'created'::text, p_tenant_id, p_request_id,
    'pending_identity_provider'::varchar;
END;
$$;
REVOKE ALL ON FUNCTION public.request_company_provisioning(
  uuid, boolean, uuid, uuid, uuid, uuid, uuid, varchar, integer, varchar, varchar
) FROM PUBLIC;

COMMIT;
