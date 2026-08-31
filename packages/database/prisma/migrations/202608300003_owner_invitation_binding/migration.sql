BEGIN;

-- A verified identity can have only one outstanding owner activation. This
-- lets the provider use one exact fixed post-action redirect without putting a
-- Kinto invitation identifier into its signed email URL.
CREATE UNIQUE INDEX owner_invitations_one_pending_identity_idx
  ON owner_invitations(identity_id)
  WHERE status IN ('pending_delivery', 'pending_activation');

CREATE OR REPLACE FUNCTION public.resolve_login_identity(
  p_issuer varchar,
  p_subject varchar,
  p_mfa_verified boolean,
  p_invitation_id uuid,
  p_membership_id uuid,
  p_tenant_audit_id uuid,
  p_platform_audit_id uuid
) RETURNS TABLE (identity_id uuid, owner_activated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_identity_id uuid;
  v_invitation record;
BEGIN
  SELECT id INTO v_identity_id FROM public.identities
   WHERE issuer = p_issuer AND subject = p_subject AND status = 'active';
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT p_mfa_verified THEN
    RETURN QUERY SELECT v_identity_id, false;
    RETURN;
  END IF;

  SELECT oi.id, oi.tenant_id, oi.status, oi.expires_at,
         r.status AS request_status
    INTO v_invitation
    FROM public.owner_invitations oi
    JOIN public.company_provisioning_requests r ON r.id = oi.request_id
    JOIN public.tenants t ON t.id = oi.tenant_id
   WHERE oi.identity_id = v_identity_id
     AND t.status = 'active'
     AND (
       (p_invitation_id IS NOT NULL AND oi.id = p_invitation_id)
       OR
       (p_invitation_id IS NULL AND oi.status = 'pending_activation')
     )
   ORDER BY oi.created_at
   LIMIT 1
   FOR UPDATE OF oi, r;
  IF NOT FOUND
     OR v_invitation.status <> 'pending_activation'
     OR v_invitation.request_status <> 'pending_activation'
     OR v_invitation.expires_at <= pg_catalog.now() THEN
    RETURN QUERY SELECT v_identity_id, false;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.memberships
     WHERE tenant_id = v_invitation.tenant_id
  ) THEN
    RETURN QUERY SELECT v_identity_id, false;
    RETURN;
  END IF;

  INSERT INTO public.memberships(id, tenant_id, identity_id, roles)
  VALUES (p_membership_id, v_invitation.tenant_id, v_identity_id, ARRAY['owner']::text[]);
  UPDATE public.owner_invitations
     SET status = 'accepted', accepted_at = pg_catalog.now(), version = version + 1
   WHERE id = v_invitation.id;
  UPDATE public.company_provisioning_requests
     SET status = 'active'
   WHERE id = (SELECT request_id FROM public.owner_invitations WHERE id = v_invitation.id);
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, resource_id)
  VALUES (p_tenant_audit_id, v_invitation.tenant_id, v_identity_id,
    'company.initial_owner_activated', p_membership_id);
  INSERT INTO public.platform_audit_events(id, actor_id, action, resource_id)
  VALUES (p_platform_audit_id, v_identity_id,
    'company.initial_owner_activated', p_membership_id);
  RETURN QUERY SELECT v_identity_id, true;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_login_identity(
  varchar, varchar, boolean, uuid, uuid, uuid, uuid
) FROM PUBLIC;

COMMIT;
