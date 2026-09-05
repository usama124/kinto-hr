BEGIN;

CREATE INDEX audit_events_tenant_action_created_id_idx
  ON public.audit_events(tenant_id, action, created_at DESC, id DESC);
CREATE INDEX audit_events_tenant_created_id_idx
  ON public.audit_events(tenant_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.list_tenant_security_audit(
  p_actor_identity_id uuid,
  p_mfa_verified boolean,
  p_tenant_id uuid,
  p_limit integer,
  p_action varchar,
  p_from timestamptz,
  p_to timestamptz,
  p_cursor_id uuid
) RETURNS TABLE (
  outcome text,
  event_id uuid,
  actor_id uuid,
  action varchar,
  reason varchar,
  resource_id uuid,
  event_created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cursor_created_at timestamptz;
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
      NULL::varchar, NULL::varchar, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100
     OR (p_action IS NOT NULL AND p_action !~ '^[a-z][a-z0-9_.]{0,99}$')
     OR (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to) THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::uuid,
      NULL::varchar, NULL::varchar, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF p_cursor_id IS NOT NULL THEN
    SELECT ae.created_at INTO v_cursor_created_at
      FROM public.audit_events ae
     WHERE ae.tenant_id = p_tenant_id AND ae.id = p_cursor_id;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid,
        NULL::varchar, NULL::varchar, NULL::uuid, NULL::timestamptz;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
    SELECT 'ok'::text, ae.id, ae.actor_id, ae.action, ae.reason,
      ae.resource_id, ae.created_at
      FROM public.audit_events ae
     WHERE ae.tenant_id = p_tenant_id
       AND (p_action IS NULL OR ae.action = p_action)
       AND (p_from IS NULL OR ae.created_at >= p_from)
       AND (p_to IS NULL OR ae.created_at <= p_to)
       AND (p_cursor_id IS NULL OR (ae.created_at, ae.id) <
            (v_cursor_created_at, p_cursor_id))
     ORDER BY ae.created_at DESC, ae.id DESC
     LIMIT p_limit + 1;
END;
$$;

COMMIT;
