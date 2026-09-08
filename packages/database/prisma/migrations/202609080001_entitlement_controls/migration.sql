BEGIN;

CREATE TABLE public.tenant_entitlement_states (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.tenant_entitlement_states(tenant_id)
SELECT tenant_id FROM public.tenant_subscriptions;

CREATE TABLE public.entitlement_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  kind varchar(30) NOT NULL CHECK (kind IN ('capacity_addon', 'complimentary')),
  employee_limit integer CHECK (employee_limit IN (5, 20, 50, 100, 250)),
  seat_delta integer CHECK (seat_delta BETWEEN 1 AND 250),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  reason varchar(240) NOT NULL CHECK (length(btrim(reason)) >= 3),
  created_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  revoked_by_identity_id uuid REFERENCES public.identities(id) ON DELETE RESTRICT,
  revoked_reason varchar(240),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((kind = 'capacity_addon' AND seat_delta IS NOT NULL AND employee_limit IS NULL)
      OR (kind = 'complimentary' AND employee_limit IS NOT NULL AND seat_delta IS NULL)),
  CHECK ((status = 'active' AND revoked_by_identity_id IS NULL AND revoked_reason IS NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_by_identity_id IS NOT NULL
          AND length(btrim(revoked_reason)) >= 3 AND revoked_at IS NOT NULL))
);
CREATE INDEX entitlement_grants_resolution_idx
  ON public.entitlement_grants(tenant_id, status, starts_at, ends_at);

CREATE TABLE public.entitlement_overrides (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  field varchar(40) NOT NULL CHECK (field = 'employee_limit'),
  employee_limit integer NOT NULL CHECK (employee_limit BETWEEN 0 AND 250),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  reason varchar(240) NOT NULL CHECK (length(btrim(reason)) >= 3),
  created_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  revoked_by_identity_id uuid REFERENCES public.identities(id) ON DELETE RESTRICT,
  revoked_reason varchar(240),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((status = 'active' AND revoked_by_identity_id IS NULL AND revoked_reason IS NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_by_identity_id IS NOT NULL
          AND length(btrim(revoked_reason)) >= 3 AND revoked_at IS NOT NULL))
);
CREATE INDEX entitlement_overrides_resolution_idx
  ON public.entitlement_overrides(tenant_id, field, status, starts_at, ends_at);

ALTER TABLE public.tenant_entitlement_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_entitlement_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.tenant_entitlement_states
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE public.entitlement_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlement_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.entitlement_grants
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE public.entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlement_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.entitlement_overrides
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION public.ensure_tenant_entitlement_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.tenant_entitlement_states(tenant_id)
  VALUES (NEW.tenant_id) ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenant_subscription_entitlement_state
  AFTER INSERT ON public.tenant_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.ensure_tenant_entitlement_state();
REVOKE ALL ON FUNCTION public.ensure_tenant_entitlement_state() FROM PUBLIC;

CREATE FUNCTION public.reject_overlapping_entitlement_override() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status = 'active' AND EXISTS (
    SELECT 1 FROM public.entitlement_overrides o
    WHERE o.tenant_id = NEW.tenant_id AND o.field = NEW.field
      AND o.status = 'active' AND o.id <> NEW.id
      AND o.starts_at < NEW.ends_at AND o.ends_at > NEW.starts_at
  ) THEN
    RAISE EXCEPTION 'overlapping active entitlement override' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER entitlement_override_no_overlap
  BEFORE INSERT OR UPDATE ON public.entitlement_overrides
  FOR EACH ROW EXECUTE FUNCTION public.reject_overlapping_entitlement_override();
REVOKE ALL ON FUNCTION public.reject_overlapping_entitlement_override() FROM PUBLIC;

CREATE FUNCTION public.resolve_tenant_entitlements_at(
  p_tenant_id uuid, p_at timestamptz,
  p_hypothetical_type varchar DEFAULT NULL,
  p_employee_limit integer DEFAULT NULL,
  p_seat_delta integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_subscription public.tenant_subscriptions%ROWTYPE;
  v_plan public.plan_versions%ROWTYPE;
  v_state_version integer;
  v_active integer;
  v_addon integer;
  v_complimentary_limit integer;
  v_override integer;
  v_limit integer;
  v_billing varchar;
BEGIN
  SELECT * INTO v_subscription FROM public.tenant_subscriptions
  WHERE tenant_id = p_tenant_id AND status = 'active' AND effective_from <= p_at
  ORDER BY subscription_version DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_plan FROM public.plan_versions WHERE id = v_subscription.plan_version_id;
  SELECT version INTO v_state_version FROM public.tenant_entitlement_states WHERE tenant_id = p_tenant_id;
  SELECT count(*)::integer INTO v_active FROM public.employees
    WHERE tenant_id = p_tenant_id AND status = 'active';
  SELECT COALESCE(sum(seat_delta), 0)::integer INTO v_addon FROM public.entitlement_grants
    WHERE tenant_id = p_tenant_id AND kind = 'capacity_addon' AND status = 'active'
      AND starts_at <= p_at AND ends_at > p_at;
  SELECT max(employee_limit) INTO v_complimentary_limit FROM public.entitlement_grants
    WHERE tenant_id = p_tenant_id AND kind = 'complimentary' AND status = 'active'
      AND starts_at <= p_at AND ends_at > p_at;
  SELECT employee_limit INTO v_override FROM public.entitlement_overrides
    WHERE tenant_id = p_tenant_id AND field = 'employee_limit' AND status = 'active'
      AND starts_at <= p_at AND ends_at > p_at ORDER BY starts_at DESC LIMIT 1;

  v_limit := greatest(v_subscription.employee_limit + v_addon, COALESCE(v_complimentary_limit, 0));
  v_billing := CASE WHEN v_complimentary_limit IS NULL THEN v_subscription.billing_mode ELSE 'complimentary' END;
  IF p_hypothetical_type = 'capacity_addon' THEN v_limit := v_limit + p_seat_delta;
  ELSIF p_hypothetical_type = 'complimentary' THEN
    v_limit := greatest(v_limit, p_employee_limit); v_billing := 'complimentary';
  ELSIF p_hypothetical_type = 'employee_limit_override' THEN v_override := p_employee_limit;
  END IF;
  IF v_override IS NOT NULL THEN v_limit := v_override; END IF;

  RETURN jsonb_build_object(
    'plan', jsonb_build_object('code', v_plan.code, 'version', v_plan.plan_version),
    'billingMode', v_billing, 'employeeLimit', v_limit,
    'activeEmployees', v_active, 'availableEmployeeSeats', greatest(v_limit - v_active, 0),
    'capabilities', v_plan.capabilities,
    'entitlementVersion', v_state_version + CASE WHEN p_hypothetical_type IS NULL THEN 0 ELSE 1 END,
    'effectiveFrom', to_char(v_subscription.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_tenant_entitlements_at(uuid, timestamptz, varchar, integer, integer) FROM PUBLIC;

CREATE FUNCTION public.current_tenant_employee_limit() RETURNS integer
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  WITH base AS (
    SELECT s.employee_limit
    FROM public.tenant_subscriptions s
    WHERE s.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND s.status = 'active' AND s.effective_from <= now()
    ORDER BY s.subscription_version DESC LIMIT 1
  )
  SELECT COALESCE(
    (SELECT o.employee_limit FROM public.entitlement_overrides o
      WHERE o.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND o.field = 'employee_limit' AND o.status = 'active'
        AND o.starts_at <= now() AND o.ends_at > now()
      ORDER BY o.starts_at DESC LIMIT 1),
    CASE WHEN (SELECT employee_limit FROM base) IS NULL THEN NULL ELSE greatest(
      (SELECT employee_limit FROM base) + COALESCE((SELECT sum(g.seat_delta)
       FROM public.entitlement_grants g
       WHERE g.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
         AND g.kind = 'capacity_addon' AND g.status = 'active'
         AND g.starts_at <= now() AND g.ends_at > now()), 0),
      COALESCE((SELECT max(g.employee_limit) FROM public.entitlement_grants g
       WHERE g.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
         AND g.kind = 'complimentary' AND g.status = 'active'
         AND g.starts_at <= now() AND g.ends_at > now()), 0)
    )
    END
  )
$$;
REVOKE ALL ON FUNCTION public.current_tenant_employee_limit() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.read_tenant_entitlements(
  p_actor_identity_id uuid, p_mfa_verified boolean, p_tenant_id uuid
) RETURNS TABLE (outcome text, snapshot jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_snapshot jsonb;
BEGIN
  IF p_mfa_verified IS NOT TRUE OR NOT EXISTS (
    SELECT 1 FROM public.identities i JOIN public.memberships m ON m.identity_id = i.id
    JOIN public.tenants t ON t.id = m.tenant_id
    WHERE i.id = p_actor_identity_id AND i.status = 'active'
      AND m.tenant_id = p_tenant_id AND m.status = 'active'
      AND (('owner' = ANY(m.roles)) OR ('hr_admin' = ANY(m.roles))) AND t.status = 'active'
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::jsonb; RETURN; END IF;
  v_snapshot := public.resolve_tenant_entitlements_at(p_tenant_id, now(), NULL, NULL, NULL);
  IF v_snapshot IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::jsonb;
  ELSE RETURN QUERY SELECT 'ok'::text, v_snapshot; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.read_tenant_entitlements(uuid, boolean, uuid) FROM PUBLIC;

CREATE FUNCTION public.preview_entitlement_change(
  p_actor_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_change_type varchar, p_starts_at timestamptz, p_ends_at timestamptz,
  p_employee_limit integer, p_seat_delta integer
) RETURNS TABLE (outcome text, preview jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  IF p_mfa_verified IS NOT TRUE OR NOT EXISTS (
    SELECT 1 FROM public.identities i JOIN public.platform_operators o ON o.identity_id = i.id
    WHERE i.id = p_actor_id AND i.status = 'active' AND o.status = 'active'
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::jsonb; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = p_tenant_id)
     OR p_starts_at IS NULL OR p_ends_at IS NULL OR p_ends_at <= p_starts_at
     OR (p_change_type = 'capacity_addon' AND (p_seat_delta IS NULL OR p_seat_delta NOT BETWEEN 1 AND 250 OR p_employee_limit IS NOT NULL))
     OR (p_change_type = 'complimentary' AND (p_employee_limit NOT IN (5,20,50,100,250) OR p_seat_delta IS NOT NULL))
     OR (p_change_type = 'employee_limit_override' AND (p_employee_limit IS NULL OR p_employee_limit NOT BETWEEN 0 AND 250 OR p_seat_delta IS NOT NULL))
     OR p_change_type NOT IN ('capacity_addon', 'complimentary', 'employee_limit_override') THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::jsonb; RETURN;
  END IF;
  IF p_change_type = 'employee_limit_override' AND EXISTS (
    SELECT 1 FROM public.entitlement_overrides o WHERE o.tenant_id = p_tenant_id
      AND o.field = 'employee_limit' AND o.status = 'active'
      AND o.starts_at < p_ends_at AND o.ends_at > p_starts_at
  ) THEN RETURN QUERY SELECT 'conflict'::text, NULL::jsonb; RETURN; END IF;
  v_before := public.resolve_tenant_entitlements_at(p_tenant_id, p_starts_at, NULL, NULL, NULL);
  v_after := public.resolve_tenant_entitlements_at(
    p_tenant_id, p_starts_at, p_change_type, p_employee_limit, p_seat_delta
  );
  IF v_before IS NULL OR v_after IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::jsonb; RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::text, jsonb_build_object(
    'at', to_char(p_starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'before', v_before, 'after', v_after,
    'changes', jsonb_build_object(
      'employeeLimit', v_before->'employeeLimit' IS DISTINCT FROM v_after->'employeeLimit',
      'billingMode', v_before->'billingMode' IS DISTINCT FROM v_after->'billingMode'
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public.preview_entitlement_change(uuid, boolean, uuid, varchar, timestamptz, timestamptz, integer, integer) FROM PUBLIC;

CREATE FUNCTION public.create_entitlement_change(
  p_actor_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_change_id uuid, p_change_type varchar, p_starts_at timestamptz,
  p_ends_at timestamptz, p_employee_limit integer, p_seat_delta integer,
  p_reason varchar, p_tenant_audit_id uuid, p_platform_audit_id uuid
) RETURNS TABLE (outcome text, change_id uuid, change_version integer, entitlement_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_entitlement_version integer;
BEGIN
  IF p_mfa_verified IS NOT TRUE OR NOT EXISTS (
    SELECT 1 FROM public.identities i JOIN public.platform_operators o ON o.identity_id = i.id
    WHERE i.id = p_actor_id AND i.status = 'active' AND o.status = 'active'
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':entitlements', 0));
  IF NOT EXISTS (SELECT 1 FROM public.tenant_entitlement_states WHERE tenant_id = p_tenant_id)
     OR p_starts_at IS NULL OR p_ends_at IS NULL OR p_ends_at <= p_starts_at
     OR p_ends_at <= now() OR p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 240
     OR (p_change_type = 'capacity_addon' AND (p_seat_delta IS NULL OR p_seat_delta NOT BETWEEN 1 AND 250 OR p_employee_limit IS NOT NULL))
     OR (p_change_type = 'complimentary' AND (p_employee_limit NOT IN (5,20,50,100,250) OR p_seat_delta IS NOT NULL))
     OR (p_change_type = 'employee_limit_override' AND (p_employee_limit IS NULL OR p_employee_limit NOT BETWEEN 0 AND 250 OR p_seat_delta IS NOT NULL))
     OR p_change_type NOT IN ('capacity_addon', 'complimentary', 'employee_limit_override') THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF p_change_type = 'employee_limit_override' AND EXISTS (
    SELECT 1 FROM public.entitlement_overrides o WHERE o.tenant_id = p_tenant_id
      AND o.field = 'employee_limit' AND o.status = 'active'
      AND o.starts_at < p_ends_at AND o.ends_at > p_starts_at
  ) THEN RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN; END IF;
  IF p_change_type IN ('capacity_addon', 'complimentary') THEN
    INSERT INTO public.entitlement_grants(
      id, tenant_id, kind, employee_limit, seat_delta, starts_at, ends_at,
      reason, created_by_identity_id
    ) VALUES (p_change_id, p_tenant_id, p_change_type, p_employee_limit,
      p_seat_delta, p_starts_at, p_ends_at, p_reason, p_actor_id);
  ELSE
    INSERT INTO public.entitlement_overrides(
      id, tenant_id, field, employee_limit, starts_at, ends_at,
      reason, created_by_identity_id
    ) VALUES (p_change_id, p_tenant_id, 'employee_limit', p_employee_limit,
      p_starts_at, p_ends_at, p_reason, p_actor_id);
  END IF;
  UPDATE public.tenant_entitlement_states SET version = version + 1, updated_at = now()
    WHERE tenant_id = p_tenant_id RETURNING version INTO v_entitlement_version;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_tenant_audit_id, p_tenant_id, p_actor_id,
      'entitlement.change_created', p_reason, p_change_id);
  INSERT INTO public.platform_audit_events(id, actor_id, action, resource_id)
    VALUES (p_platform_audit_id, p_actor_id, 'entitlement.change_created', p_change_id);
  RETURN QUERY SELECT 'created'::text, p_change_id, 1, v_entitlement_version;
END;
$$;
REVOKE ALL ON FUNCTION public.create_entitlement_change(uuid, boolean, uuid, uuid, varchar, timestamptz, timestamptz, integer, integer, varchar, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION public.revoke_entitlement_change(
  p_actor_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_change_type varchar, p_change_id uuid, p_expected_version integer,
  p_reason varchar, p_tenant_audit_id uuid, p_platform_audit_id uuid
) RETURNS TABLE (outcome text, change_id uuid, change_version integer, entitlement_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_current_version integer; v_status varchar; v_new_version integer; v_entitlement_version integer;
BEGIN
  IF p_mfa_verified IS NOT TRUE OR NOT EXISTS (
    SELECT 1 FROM public.identities i JOIN public.platform_operators o ON o.identity_id = i.id
    WHERE i.id = p_actor_id AND i.status = 'active' AND o.status = 'active'
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':entitlements', 0));
  IF p_change_type = 'grant' THEN
    SELECT version, status INTO v_current_version, v_status FROM public.entitlement_grants
      WHERE tenant_id = p_tenant_id AND id = p_change_id FOR UPDATE;
  ELSIF p_change_type = 'override' THEN
    SELECT version, status INTO v_current_version, v_status FROM public.entitlement_overrides
      WHERE tenant_id = p_tenant_id AND id = p_change_id FOR UPDATE;
  ELSE RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN; END IF;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN; END IF;
  IF p_expected_version IS NULL OR v_current_version <> p_expected_version OR v_status <> 'active' THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 240 THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer, NULL::integer; RETURN;
  END IF;
  v_new_version := v_current_version + 1;
  IF p_change_type = 'grant' THEN
    UPDATE public.entitlement_grants SET status = 'revoked', version = v_new_version,
      revoked_by_identity_id = p_actor_id, revoked_reason = p_reason, revoked_at = now()
      WHERE tenant_id = p_tenant_id AND id = p_change_id;
  ELSE
    UPDATE public.entitlement_overrides SET status = 'revoked', version = v_new_version,
      revoked_by_identity_id = p_actor_id, revoked_reason = p_reason, revoked_at = now()
      WHERE tenant_id = p_tenant_id AND id = p_change_id;
  END IF;
  UPDATE public.tenant_entitlement_states SET version = version + 1, updated_at = now()
    WHERE tenant_id = p_tenant_id RETURNING version INTO v_entitlement_version;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_tenant_audit_id, p_tenant_id, p_actor_id,
      'entitlement.change_revoked', p_reason, p_change_id);
  INSERT INTO public.platform_audit_events(id, actor_id, action, resource_id)
    VALUES (p_platform_audit_id, p_actor_id, 'entitlement.change_revoked', p_change_id);
  RETURN QUERY SELECT 'revoked'::text, p_change_id, v_new_version, v_entitlement_version;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_entitlement_change(uuid, boolean, uuid, varchar, uuid, integer, varchar, uuid, uuid) FROM PUBLIC;

COMMIT;
