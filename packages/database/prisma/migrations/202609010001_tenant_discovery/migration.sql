BEGIN;

-- Return only the active customer workspaces available to the exact identity
-- resolved from the server session. Selection is session context, never an
-- authorization substitute; every business operation still rechecks access.
CREATE FUNCTION public.discover_identity_tenants(
  p_identity_id uuid
) RETURNS TABLE (
  tenant_id uuid,
  tenant_name varchar,
  membership_id uuid,
  membership_roles text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.name, m.id, m.roles
    FROM public.identities i
    JOIN public.memberships m ON m.identity_id = i.id
    JOIN public.tenants t ON t.id = m.tenant_id
   WHERE i.id = p_identity_id
     AND i.status = 'active'
     AND m.status = 'active'
     AND t.status = 'active'
   ORDER BY lower(t.name), t.id;
$$;
REVOKE ALL ON FUNCTION public.discover_identity_tenants(uuid) FROM PUBLIC;

COMMIT;
