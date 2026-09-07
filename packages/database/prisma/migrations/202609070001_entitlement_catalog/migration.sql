BEGIN;

CREATE TABLE public.plan_versions (
  id uuid PRIMARY KEY,
  code varchar(30) NOT NULL CHECK (code IN ('free', 'starter', 'growth', 'business', 'scale')),
  plan_version integer NOT NULL CHECK (plan_version > 0),
  employee_limit integer NOT NULL CHECK (employee_limit IN (5, 20, 50, 100, 250)),
  capabilities jsonb NOT NULL CHECK (
    capabilities = '{"companySetup": true}'::jsonb
  ),
  status varchar(20) NOT NULL DEFAULT 'test_seed' CHECK (status = 'test_seed'),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, plan_version)
);

INSERT INTO public.plan_versions(id, code, plan_version, employee_limit, capabilities)
VALUES
  ('10000000-0000-4000-8000-000000000005', 'free', 1, 5, '{"companySetup": true}'),
  ('10000000-0000-4000-8000-000000000020', 'starter', 1, 20, '{"companySetup": true}'),
  ('10000000-0000-4000-8000-000000000050', 'growth', 1, 50, '{"companySetup": true}'),
  ('10000000-0000-4000-8000-000000000100', 'business', 1, 100, '{"companySetup": true}'),
  ('10000000-0000-4000-8000-000000000250', 'scale', 1, 250, '{"companySetup": true}');

CREATE TABLE public.tenant_subscriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  subscription_version integer NOT NULL CHECK (subscription_version > 0),
  plan_version_id uuid NOT NULL REFERENCES public.plan_versions(id) ON DELETE RESTRICT,
  billing_mode varchar(20) NOT NULL CHECK (billing_mode IN ('free', 'complimentary', 'manual_paid')),
  employee_limit integer NOT NULL CHECK (employee_limit >= 0 AND employee_limit <= 250),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  reason varchar(240) NOT NULL CHECK (length(btrim(reason)) >= 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subscription_version),
  CHECK ((status = 'active' AND ended_at IS NULL) OR (status = 'ended' AND ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX tenant_subscriptions_one_active
  ON public.tenant_subscriptions(tenant_id) WHERE status = 'active';
CREATE INDEX tenant_subscriptions_resolution_idx
  ON public.tenant_subscriptions(tenant_id, status, effective_from DESC);

-- Preserve pre-catalog capacity exactly while associating it with the smallest
-- package that can contain it. Fresh provisioning accepts only package limits.
INSERT INTO public.tenant_subscriptions(
  id, tenant_id, subscription_version, plan_version_id, billing_mode,
  employee_limit, reason
)
SELECT gen_random_uuid(), t.id, 1, p.id, t.billing_mode, t.employee_limit,
  'Migrated legacy tenant capacity'
FROM public.tenants t
JOIN LATERAL (
  SELECT id FROM public.plan_versions
  WHERE employee_limit >= t.employee_limit
  ORDER BY employee_limit ASC LIMIT 1
) p ON true;

ALTER TABLE public.plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_denied ON public.plan_versions USING (false) WITH CHECK (false);
ALTER TABLE public.tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.tenant_subscriptions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION public.prevent_plan_version_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'plan versions are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER plan_versions_immutable
  BEFORE UPDATE OR DELETE ON public.plan_versions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_plan_version_mutation();
REVOKE ALL ON FUNCTION public.prevent_plan_version_mutation() FROM PUBLIC;

CREATE FUNCTION public.read_tenant_entitlements(
  p_actor_identity_id uuid,
  p_mfa_verified boolean,
  p_tenant_id uuid
) RETURNS TABLE (outcome text, snapshot jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_mfa_verified IS NOT TRUE OR NOT EXISTS (
    SELECT 1 FROM public.identities i
    JOIN public.memberships m ON m.identity_id = i.id
    JOIN public.tenants t ON t.id = m.tenant_id
    WHERE i.id = p_actor_identity_id AND i.status = 'active'
      AND m.tenant_id = p_tenant_id AND m.status = 'active'
      AND (('owner' = ANY(m.roles)) OR ('hr_admin' = ANY(m.roles)))
      AND t.status = 'active'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::jsonb;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT 'ok'::text, jsonb_build_object(
    'plan', jsonb_build_object('code', p.code, 'version', p.plan_version),
    'billingMode', s.billing_mode,
    'employeeLimit', s.employee_limit,
    'activeEmployees', counts.active_employees,
    'availableEmployeeSeats', greatest(s.employee_limit - counts.active_employees, 0),
    'capabilities', p.capabilities,
    'entitlementVersion', s.subscription_version,
    'effectiveFrom', to_char(s.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
  FROM public.tenant_subscriptions s
  JOIN public.plan_versions p ON p.id = s.plan_version_id
  CROSS JOIN LATERAL (
    SELECT count(*)::integer AS active_employees FROM public.employees e
    WHERE e.tenant_id = p_tenant_id AND e.status = 'active'
  ) counts
  WHERE s.tenant_id = p_tenant_id AND s.status = 'active'
    AND s.effective_from <= now()
  ORDER BY s.subscription_version DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::jsonb;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.read_tenant_entitlements(uuid, boolean, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.request_company_provisioning(
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_existing record;
  v_plan_id uuid;
BEGIN
  IF p_mfa_verified IS NOT TRUE OR NOT EXISTS (
    SELECT 1 FROM public.identities i
    JOIN public.platform_operators o ON o.identity_id = i.id
    WHERE i.id = p_actor_id AND i.status = 'active' AND o.status = 'active'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::uuid, NULL::varchar;
    RETURN;
  END IF;

  SELECT id INTO v_plan_id FROM public.plan_versions
  WHERE employee_limit = p_employee_limit AND plan_version = 1 AND status = 'test_seed';
  IF NOT FOUND OR p_billing_mode IS NULL
     OR p_billing_mode NOT IN ('free', 'complimentary', 'manual_paid')
     OR (p_billing_mode = 'free' AND p_employee_limit <> 5) THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::uuid, NULL::varchar;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text || ':' || p_request_key::text, 0));
  SELECT r.id, r.tenant_id, r.initial_owner_email, r.status,
         t.name, t.employee_limit, t.billing_mode
    INTO v_existing
    FROM public.company_provisioning_requests r
    JOIN public.tenants t ON t.id = r.tenant_id
   WHERE r.requested_by_identity_id = p_actor_id AND r.request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.name IS DISTINCT FROM p_company_name
       OR v_existing.employee_limit IS DISTINCT FROM p_employee_limit
       OR v_existing.billing_mode IS DISTINCT FROM p_billing_mode
       OR v_existing.initial_owner_email IS DISTINCT FROM p_initial_owner_email THEN
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::uuid, NULL::varchar;
    ELSE
      RETURN QUERY SELECT 'existing'::text, v_existing.tenant_id, v_existing.id, v_existing.status;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.tenants(id, name, employee_limit, billing_mode)
  VALUES (p_tenant_id, p_company_name, p_employee_limit, p_billing_mode);
  INSERT INTO public.tenant_subscriptions(
    id, tenant_id, subscription_version, plan_version_id, billing_mode,
    employee_limit, reason
  ) VALUES (
    gen_random_uuid(), p_tenant_id, 1, v_plan_id, p_billing_mode,
    p_employee_limit, 'Initial platform-provisioned subscription'
  );
  INSERT INTO public.company_provisioning_requests(
    id, request_key, requested_by_identity_id, tenant_id, initial_owner_email
  ) VALUES (p_request_id, p_request_key, p_actor_id, p_tenant_id, p_initial_owner_email);
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, resource_id)
  VALUES (p_tenant_audit_id, p_tenant_id, p_actor_id, 'company.provisioning_requested', p_request_id);
  INSERT INTO public.platform_audit_events(id, actor_id, action, resource_id)
  VALUES (p_platform_audit_id, p_actor_id, 'company.provisioning_requested', p_tenant_id);
  RETURN QUERY SELECT 'created'::text, p_tenant_id, p_request_id, 'pending_identity_provider'::varchar;
END;
$$;
REVOKE ALL ON FUNCTION public.request_company_provisioning(
  uuid, boolean, uuid, uuid, uuid, uuid, uuid, varchar, integer, varchar, varchar
) FROM PUBLIC;

COMMIT;
