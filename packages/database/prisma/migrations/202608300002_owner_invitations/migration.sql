BEGIN;

-- Provider action tokens remain entirely inside the identity provider. Kinto
-- stores only the approved identity binding, lifecycle state and expiry.
CREATE TABLE owner_invitations (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES company_provisioning_requests(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  status varchar(30) NOT NULL DEFAULT 'pending_delivery' CHECK (
    status IN ('pending_delivery', 'pending_activation', 'accepted', 'revoked')
  ),
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  accepted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, identity_id),
  CHECK (delivered_at IS NULL OR delivered_at >= created_at),
  CHECK (accepted_at IS NULL OR accepted_at >= created_at)
);
CREATE INDEX owner_invitations_status_expires_at_idx ON owner_invitations(status, expires_at);
ALTER TABLE owner_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_invitations FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.reconcile_company_owner_provider(
  p_request_id uuid,
  p_invitation_id uuid,
  p_identity_id uuid,
  p_issuer varchar,
  p_subject varchar,
  p_expires_at timestamptz,
  p_tenant_audit_id uuid,
  p_platform_audit_id uuid
) RETURNS TABLE (
  outcome text,
  invitation_id uuid,
  invitation_status varchar,
  invitation_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request record;
  v_invitation record;
  v_identity_id uuid;
BEGIN
  IF length(p_issuer) NOT BETWEEN 1 AND 512
     OR length(p_subject) NOT BETWEEN 1 AND 255
     OR p_expires_at <= pg_catalog.now()
     OR p_expires_at > pg_catalog.now() + interval '48 hours 5 minutes' THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::varchar, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT id, tenant_id, status INTO v_request
    FROM public.company_provisioning_requests
   WHERE id = p_request_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::varchar, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_request.status IN ('failed', 'revoked') THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::varchar, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT oi.id, oi.status, oi.expires_at, i.issuer, i.subject
    INTO v_invitation
    FROM public.owner_invitations oi
    JOIN public.identities i ON i.id = oi.identity_id
   WHERE oi.request_id = p_request_id;
  IF FOUND THEN
    IF v_invitation.issuer IS DISTINCT FROM p_issuer
       OR v_invitation.subject IS DISTINCT FROM p_subject THEN
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::varchar, NULL::timestamptz;
    ELSE
      RETURN QUERY SELECT 'existing'::text, v_invitation.id,
        v_invitation.status, v_invitation.expires_at;
    END IF;
    RETURN;
  END IF;
  SELECT id INTO v_identity_id FROM public.identities
   WHERE issuer = p_issuer AND subject = p_subject;
  IF FOUND THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.identities
       WHERE id = v_identity_id AND status = 'active'
    ) THEN
      RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::varchar, NULL::timestamptz;
      RETURN;
    END IF;
  ELSE
    v_identity_id := p_identity_id;
    INSERT INTO public.identities(id, issuer, subject)
    VALUES (v_identity_id, p_issuer, p_subject);
  END IF;

  INSERT INTO public.owner_invitations(
    id, request_id, tenant_id, identity_id, expires_at
  ) VALUES (
    p_invitation_id, p_request_id, v_request.tenant_id, v_identity_id, p_expires_at
  );
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, resource_id)
  VALUES (p_tenant_audit_id, v_request.tenant_id,
    (SELECT requested_by_identity_id FROM public.company_provisioning_requests WHERE id = p_request_id),
    'company.owner_provider_reconciled', p_invitation_id);
  INSERT INTO public.platform_audit_events(id, actor_id, action, resource_id)
  VALUES (p_platform_audit_id,
    (SELECT requested_by_identity_id FROM public.company_provisioning_requests WHERE id = p_request_id),
    'company.owner_provider_reconciled', p_invitation_id);

  RETURN QUERY SELECT 'created'::text, p_invitation_id,
    'pending_delivery'::varchar, p_expires_at;
END;
$$;
REVOKE ALL ON FUNCTION public.reconcile_company_owner_provider(
  uuid, uuid, uuid, varchar, varchar, timestamptz, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION public.mark_company_owner_invitation_delivered(
  p_request_id uuid,
  p_expires_at timestamptz,
  p_tenant_audit_id uuid,
  p_platform_audit_id uuid
) RETURNS TABLE (outcome text, invitation_status varchar)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_invitation record;
BEGIN
  IF p_expires_at <= pg_catalog.now()
     OR p_expires_at > pg_catalog.now() + interval '48 hours 5 minutes' THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::varchar;
    RETURN;
  END IF;
  SELECT oi.id, oi.tenant_id, oi.status, oi.expires_at,
         r.requested_by_identity_id, r.status AS request_status
    INTO v_invitation
    FROM public.owner_invitations oi
    JOIN public.company_provisioning_requests r ON r.id = oi.request_id
   WHERE oi.request_id = p_request_id
   FOR UPDATE OF oi, r;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::varchar;
    RETURN;
  END IF;
  IF v_invitation.status = 'accepted' THEN
    RETURN QUERY SELECT 'existing'::text, 'accepted'::varchar;
    RETURN;
  END IF;
  IF v_invitation.status = 'revoked'
     OR v_invitation.request_status IN ('failed', 'revoked') THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::varchar;
    RETURN;
  END IF;
  IF v_invitation.status = 'pending_activation'
     AND v_invitation.expires_at > pg_catalog.now() THEN
    RETURN QUERY SELECT 'existing'::text, 'pending_activation'::varchar;
    RETURN;
  END IF;

  UPDATE public.owner_invitations
     SET status = 'pending_activation', expires_at = p_expires_at,
         delivered_at = pg_catalog.now(), version = version + 1
   WHERE id = v_invitation.id;
  UPDATE public.company_provisioning_requests
     SET status = 'pending_activation'
   WHERE id = p_request_id;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, resource_id)
  VALUES (p_tenant_audit_id, v_invitation.tenant_id,
    v_invitation.requested_by_identity_id,
    'company.owner_invitation_delivered', v_invitation.id);
  INSERT INTO public.platform_audit_events(id, actor_id, action, resource_id)
  VALUES (p_platform_audit_id, v_invitation.requested_by_identity_id,
    'company.owner_invitation_delivered', v_invitation.id);
  RETURN QUERY SELECT 'updated'::text, 'pending_activation'::varchar;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_company_owner_invitation_delivered(
  uuid, timestamptz, uuid, uuid
) FROM PUBLIC;

CREATE FUNCTION public.resolve_login_identity(
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
  IF NOT p_mfa_verified OR p_invitation_id IS NULL THEN
    RETURN QUERY SELECT v_identity_id, false;
    RETURN;
  END IF;

  SELECT oi.id, oi.tenant_id, oi.status, oi.expires_at,
         r.status AS request_status
    INTO v_invitation
    FROM public.owner_invitations oi
    JOIN public.company_provisioning_requests r ON r.id = oi.request_id
    JOIN public.tenants t ON t.id = oi.tenant_id
   WHERE oi.id = p_invitation_id
     AND oi.identity_id = v_identity_id
     AND t.status = 'active'
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
