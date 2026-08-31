BEGIN;

CREATE FUNCTION public.list_tenant_memberships(
  p_actor_identity_id uuid,
  p_mfa_verified boolean,
  p_tenant_id uuid
) RETURNS TABLE (
  outcome text,
  membership_id uuid,
  identity_id uuid,
  membership_status varchar,
  membership_roles text[],
  membership_version integer,
  employee_id uuid,
  membership_created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_mfa_verified IS DISTINCT FROM true OR NOT EXISTS (
    SELECT 1
      FROM public.identities i
      JOIN public.memberships m ON m.identity_id = i.id
      JOIN public.tenants t ON t.id = m.tenant_id
     WHERE i.id = p_actor_identity_id
       AND i.status = 'active'
       AND m.tenant_id = p_tenant_id
       AND m.status = 'active'
       AND 'owner' = ANY(m.roles)
       AND t.status = 'active'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::uuid,
      NULL::varchar, NULL::text[], NULL::integer, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT 'ok'::text, m.id, m.identity_id, m.status, m.roles, m.version,
      eil.employee_id, m.created_at
      FROM public.memberships m
      LEFT JOIN public.employee_identity_links eil
        ON eil.tenant_id = m.tenant_id AND eil.membership_id = m.id
     WHERE m.tenant_id = p_tenant_id
     ORDER BY m.created_at, m.id;
END;
$$;
REVOKE ALL ON FUNCTION public.list_tenant_memberships(uuid, boolean, uuid)
  FROM PUBLIC;

CREATE FUNCTION public.mutate_tenant_membership(
  p_actor_identity_id uuid,
  p_mfa_verified boolean,
  p_tenant_id uuid,
  p_membership_id uuid,
  p_expected_version integer,
  p_roles text[],
  p_revoke boolean,
  p_reason varchar,
  p_audit_id uuid
) RETURNS TABLE (
  outcome text,
  membership_status varchar,
  membership_roles text[],
  membership_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_target record;
  v_updated record;
  v_roles text[];
BEGIN
  IF p_expected_version IS NULL
     OR p_expected_version < 1
     OR p_revoke IS NULL
     OR p_reason IS NULL
     OR length(btrim(p_reason, E' \t\n\r')) NOT BETWEEN 3 AND 240
     OR (p_revoke AND p_roles IS NOT NULL)
     OR (NOT p_revoke AND (
       p_roles IS NULL
       OR cardinality(p_roles) NOT BETWEEN 1 AND 4
       OR EXISTS (
         SELECT 1 FROM unnest(p_roles) AS role
          WHERE role NOT IN ('owner', 'hr_admin', 'payroll_preparer', 'payroll_approver')
       )
       OR (SELECT count(DISTINCT role) FROM unnest(p_roles) AS role)
          <> cardinality(p_roles)
     )) THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::varchar, NULL::text[], NULL::integer;
    RETURN;
  END IF;
  IF NOT p_revoke THEN
    SELECT array_agg(candidate.role ORDER BY candidate.position)
      INTO v_roles
      FROM unnest(ARRAY[
        'owner', 'hr_admin', 'payroll_preparer', 'payroll_approver'
      ]::text[]) WITH ORDINALITY AS candidate(role, position)
     WHERE candidate.role = ANY(p_roles);
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id::text, 0)
  );
  IF p_mfa_verified IS DISTINCT FROM true OR NOT EXISTS (
    SELECT 1
      FROM public.identities i
      JOIN public.memberships m ON m.identity_id = i.id
      JOIN public.tenants t ON t.id = m.tenant_id
     WHERE i.id = p_actor_identity_id
       AND i.status = 'active'
       AND m.tenant_id = p_tenant_id
       AND m.status = 'active'
       AND 'owner' = ANY(m.roles)
       AND t.status = 'active'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::varchar, NULL::text[], NULL::integer;
    RETURN;
  END IF;

  SELECT m.status, m.roles, m.version INTO v_target
    FROM public.memberships m
   WHERE m.tenant_id = p_tenant_id AND m.id = p_membership_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::varchar, NULL::text[], NULL::integer;
    RETURN;
  END IF;
  IF v_target.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale'::text, v_target.status, v_target.roles, v_target.version;
    RETURN;
  END IF;
  IF v_target.status <> 'active' THEN
    RETURN QUERY SELECT 'invalid_state'::text, v_target.status, v_target.roles, v_target.version;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.employee_identity_links
     WHERE tenant_id = p_tenant_id AND membership_id = p_membership_id
  ) THEN
    RETURN QUERY SELECT 'employee_linked'::text, v_target.status, v_target.roles, v_target.version;
    RETURN;
  END IF;
  IF 'owner' = ANY(v_target.roles)
     AND (p_revoke OR NOT ('owner' = ANY(v_roles)))
     AND NOT EXISTS (
       SELECT 1 FROM public.memberships
        WHERE tenant_id = p_tenant_id
          AND status = 'active'
          AND id <> p_membership_id
          AND 'owner' = ANY(roles)
     ) THEN
    RETURN QUERY SELECT 'last_owner'::text, v_target.status, v_target.roles, v_target.version;
    RETURN;
  END IF;
  IF NOT p_revoke AND v_target.roles = v_roles THEN
    RETURN QUERY SELECT 'conflict'::text, v_target.status, v_target.roles, v_target.version;
    RETURN;
  END IF;

  IF p_revoke THEN
    UPDATE public.memberships
       SET status = 'revoked', version = version + 1
     WHERE tenant_id = p_tenant_id AND id = p_membership_id
     RETURNING status, roles, version INTO v_updated;
  ELSE
    UPDATE public.memberships
       SET roles = v_roles, version = version + 1
     WHERE tenant_id = p_tenant_id AND id = p_membership_id
     RETURNING status, roles, version INTO v_updated;
  END IF;
  INSERT INTO public.audit_events(
    id, tenant_id, actor_id, action, reason, resource_id
  ) VALUES (
    p_audit_id, p_tenant_id, p_actor_identity_id,
    CASE WHEN p_revoke THEN 'membership.revoked' ELSE 'membership.roles_changed' END,
    btrim(p_reason, E' \t\n\r'), p_membership_id
  );
  RETURN QUERY SELECT 'updated'::text, v_updated.status,
    v_updated.roles, v_updated.version;
END;
$$;
REVOKE ALL ON FUNCTION public.mutate_tenant_membership(
  uuid, boolean, uuid, uuid, integer, text[], boolean, varchar, uuid
) FROM PUBLIC;

COMMIT;
