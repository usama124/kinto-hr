BEGIN;

CREATE FUNCTION public.check_platform_operator_access(p_actor uuid, p_mfa boolean)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_mfa IS TRUE AND EXISTS (
    SELECT 1 FROM public.identities i
    JOIN public.platform_operators o ON o.identity_id = i.id
    WHERE i.id = p_actor AND i.status = 'active' AND o.status = 'active'
  );
$$;
REVOKE ALL ON FUNCTION public.check_platform_operator_access(uuid,boolean) FROM PUBLIC;

COMMIT;
