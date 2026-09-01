BEGIN;

CREATE TABLE administrator_account_requests (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  requested_by_identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  email varchar(320) NOT NULL CHECK (
    length(email) BETWEEN 3 AND 320 AND email = lower(email)
  ),
  roles text[] NOT NULL CHECK (
    cardinality(roles) BETWEEN 1 AND 4
    AND roles <@ ARRAY['owner', 'hr_admin', 'payroll_preparer', 'payroll_approver']::text[]
  ),
  reason varchar(240) NOT NULL CHECK (
    length(btrim(reason, E' \t\n\r')) BETWEEN 3 AND 240
  ),
  status varchar(40) NOT NULL DEFAULT 'pending_identity_provider' CHECK (
    status IN (
      'pending_identity_provider', 'pending_delivery', 'pending_activation',
      'active', 'failed', 'revoked'
    )
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_key),
  UNIQUE (tenant_id, email)
);
ALTER TABLE administrator_account_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE administrator_account_requests FORCE ROW LEVEL SECURITY;

CREATE TABLE administrator_invitations (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE
    REFERENCES administrator_account_requests(id) ON DELETE RESTRICT,
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
CREATE UNIQUE INDEX administrator_invitations_one_pending_identity_idx
  ON administrator_invitations(identity_id)
  WHERE status IN ('pending_delivery', 'pending_activation');
CREATE INDEX administrator_invitations_status_expires_at_idx
  ON administrator_invitations(status, expires_at);
ALTER TABLE administrator_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE administrator_invitations FORCE ROW LEVEL SECURITY;

-- Every invitation creator already locks its provider identity. This trigger
-- makes the one-outstanding-invitation rule authoritative across all three
-- invitation tables, including future callers of the older functions.
CREATE FUNCTION public.enforce_one_pending_identity_invitation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.identity_id::text, 0)
  );
  IF (TG_TABLE_NAME <> 'owner_invitations' AND EXISTS (
        SELECT 1 FROM public.owner_invitations
         WHERE identity_id = NEW.identity_id
           AND status IN ('pending_delivery', 'pending_activation')
      )) OR (TG_TABLE_NAME <> 'employee_invitations' AND EXISTS (
        SELECT 1 FROM public.employee_invitations
         WHERE identity_id = NEW.identity_id
           AND status IN ('pending_delivery', 'pending_activation')
      )) OR (TG_TABLE_NAME <> 'administrator_invitations' AND EXISTS (
        SELECT 1 FROM public.administrator_invitations
         WHERE identity_id = NEW.identity_id
           AND status IN ('pending_delivery', 'pending_activation')
      )) THEN
    RAISE EXCEPTION 'provider identity already has a pending invitation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_one_pending_identity_invitation()
  FROM PUBLIC;
CREATE TRIGGER owner_invitation_pending_identity_guard
  BEFORE INSERT ON owner_invitations FOR EACH ROW
  EXECUTE FUNCTION public.enforce_one_pending_identity_invitation();
CREATE TRIGGER employee_invitation_pending_identity_guard
  BEFORE INSERT ON employee_invitations FOR EACH ROW
  EXECUTE FUNCTION public.enforce_one_pending_identity_invitation();
CREATE TRIGGER administrator_invitation_pending_identity_guard
  BEFORE INSERT ON administrator_invitations FOR EACH ROW
  EXECUTE FUNCTION public.enforce_one_pending_identity_invitation();

CREATE FUNCTION public.request_administrator_invitation(
  p_actor_id uuid,
  p_mfa_verified boolean,
  p_tenant_id uuid,
  p_request_key uuid,
  p_request_id uuid,
  p_audit_id uuid,
  p_email varchar,
  p_roles text[],
  p_reason varchar
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
  v_roles text[];
BEGIN
  IF p_mfa_verified IS DISTINCT FROM true
     OR p_email IS NULL OR length(p_email) NOT BETWEEN 3 AND 320
     OR p_email IS DISTINCT FROM lower(p_email)
     OR p_roles IS NULL OR cardinality(p_roles) NOT BETWEEN 1 AND 4
     OR EXISTS (
       SELECT 1 FROM unnest(p_roles) AS role
        WHERE role NOT IN ('owner', 'hr_admin', 'payroll_preparer', 'payroll_approver')
     )
     OR (SELECT count(DISTINCT role) FROM unnest(p_roles) AS role)
        <> cardinality(p_roles)
     OR p_reason IS NULL
     OR length(btrim(p_reason, E' \t\n\r')) NOT BETWEEN 3 AND 240
     OR NOT EXISTS (
       SELECT 1
         FROM public.identities i
         JOIN public.memberships m ON m.identity_id = i.id
         JOIN public.tenants t ON t.id = m.tenant_id
        WHERE i.id = p_actor_id AND i.status = 'active'
          AND m.tenant_id = p_tenant_id AND m.status = 'active'
          AND 'owner' = ANY(m.roles) AND t.status = 'active'
     ) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::varchar;
    RETURN;
  END IF;
  SELECT array_agg(candidate.role ORDER BY candidate.position)
    INTO v_roles
    FROM unnest(ARRAY[
      'owner', 'hr_admin', 'payroll_preparer', 'payroll_approver'
    ]::text[]) WITH ORDINALITY AS candidate(role, position)
   WHERE candidate.role = ANY(p_roles);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id::text || ':' || p_email, 0)
  );
  SELECT id, requested_by_identity_id, email, roles, reason, status
    INTO v_existing FROM public.administrator_account_requests
   WHERE tenant_id = p_tenant_id AND request_key = p_request_key;
  IF FOUND THEN
    IF v_existing.requested_by_identity_id IS DISTINCT FROM p_actor_id
       OR v_existing.email IS DISTINCT FROM p_email
       OR v_existing.roles IS DISTINCT FROM v_roles
       OR v_existing.reason IS DISTINCT FROM btrim(p_reason, E' \t\n\r') THEN
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::varchar;
    ELSE
      RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.status;
    END IF;
    RETURN;
  END IF;
  SELECT id, roles, reason, status INTO v_existing
    FROM public.administrator_account_requests
   WHERE tenant_id = p_tenant_id AND email = p_email;
  IF FOUND THEN
    IF v_existing.roles IS DISTINCT FROM v_roles
       OR v_existing.reason IS DISTINCT FROM btrim(p_reason, E' \t\n\r') THEN
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::varchar;
    ELSE
      RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.status;
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.administrator_account_requests(
    id, request_key, tenant_id, requested_by_identity_id,
    email, roles, reason
  ) VALUES (
    p_request_id, p_request_key, p_tenant_id, p_actor_id,
    p_email, v_roles, btrim(p_reason, E' \t\n\r')
  );
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
  VALUES (p_audit_id, p_tenant_id, p_actor_id,
    'administrator.invitation_requested', btrim(p_reason, E' \t\n\r'), p_request_id);
  RETURN QUERY SELECT 'created'::text, p_request_id,
    'pending_identity_provider'::varchar;
END;
$$;
REVOKE ALL ON FUNCTION public.request_administrator_invitation(
  uuid, boolean, uuid, uuid, uuid, uuid, varchar, text[], varchar
) FROM PUBLIC;

CREATE FUNCTION public.reconcile_administrator_invitation_provider(
  p_request_id uuid,
  p_invitation_id uuid,
  p_identity_id uuid,
  p_issuer varchar,
  p_subject varchar,
  p_expires_at timestamptz,
  p_audit_id uuid
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
  IF p_issuer IS NULL OR length(p_issuer) NOT BETWEEN 1 AND 512
     OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255
     OR p_expires_at IS NULL OR p_expires_at <= pg_catalog.now()
     OR p_expires_at > pg_catalog.now() + interval '48 hours 5 minutes' THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::varchar, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT r.id, r.tenant_id, r.requested_by_identity_id, r.status,
         t.status AS tenant_status
    INTO v_request
    FROM public.administrator_account_requests r
    JOIN public.tenants t ON t.id = r.tenant_id
   WHERE r.id = p_request_id
   FOR UPDATE OF r;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::varchar, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_request.status IN ('failed', 'revoked', 'active')
     OR v_request.tenant_status <> 'active' THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::varchar, NULL::timestamptz;
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_issuer || ':' || p_subject, 0)
  );
  SELECT ai.id, ai.status, ai.expires_at, i.issuer, i.subject
    INTO v_invitation
    FROM public.administrator_invitations ai
    JOIN public.identities i ON i.id = ai.identity_id
   WHERE ai.request_id = p_request_id;
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
    IF NOT EXISTS (SELECT 1 FROM public.identities
      WHERE id = v_identity_id AND status = 'active') THEN
      RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::varchar, NULL::timestamptz;
      RETURN;
    END IF;
  ELSE
    v_identity_id := p_identity_id;
    INSERT INTO public.identities(id, issuer, subject)
    VALUES (v_identity_id, p_issuer, p_subject);
  END IF;
  IF EXISTS (SELECT 1 FROM public.memberships
      WHERE tenant_id = v_request.tenant_id AND identity_id = v_identity_id)
     OR EXISTS (SELECT 1 FROM public.owner_invitations
      WHERE identity_id = v_identity_id
        AND status IN ('pending_delivery', 'pending_activation'))
     OR EXISTS (SELECT 1 FROM public.employee_invitations
      WHERE identity_id = v_identity_id
        AND status IN ('pending_delivery', 'pending_activation'))
     OR EXISTS (SELECT 1 FROM public.administrator_invitations
      WHERE identity_id = v_identity_id
        AND status IN ('pending_delivery', 'pending_activation')) THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::varchar, NULL::timestamptz;
    RETURN;
  END IF;

  INSERT INTO public.administrator_invitations(
    id, request_id, tenant_id, identity_id, expires_at
  ) VALUES (
    p_invitation_id, p_request_id, v_request.tenant_id,
    v_identity_id, p_expires_at
  );
  UPDATE public.administrator_account_requests
     SET status = 'pending_delivery', version = version + 1
   WHERE id = p_request_id;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, resource_id)
  VALUES (p_audit_id, v_request.tenant_id, v_request.requested_by_identity_id,
    'administrator.invitation_provider_reconciled', p_invitation_id);
  RETURN QUERY SELECT 'created'::text, p_invitation_id,
    'pending_delivery'::varchar, p_expires_at;
END;
$$;
REVOKE ALL ON FUNCTION public.reconcile_administrator_invitation_provider(
  uuid, uuid, uuid, varchar, varchar, timestamptz, uuid
) FROM PUBLIC;

CREATE FUNCTION public.mark_administrator_invitation_delivered(
  p_request_id uuid,
  p_expires_at timestamptz,
  p_audit_id uuid
) RETURNS TABLE (outcome text, invitation_status varchar)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_invitation record;
BEGIN
  IF p_expires_at IS NULL OR p_expires_at <= pg_catalog.now()
     OR p_expires_at > pg_catalog.now() + interval '48 hours 5 minutes' THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::varchar;
    RETURN;
  END IF;
  SELECT ai.id, ai.tenant_id, ai.status, ai.expires_at,
         r.requested_by_identity_id, r.status AS request_status
    INTO v_invitation
    FROM public.administrator_invitations ai
    JOIN public.administrator_account_requests r ON r.id = ai.request_id
   WHERE ai.request_id = p_request_id
   FOR UPDATE OF ai, r;
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
  UPDATE public.administrator_invitations
     SET status = 'pending_activation', expires_at = p_expires_at,
         delivered_at = pg_catalog.now(), version = version + 1
   WHERE id = v_invitation.id;
  UPDATE public.administrator_account_requests
     SET status = 'pending_activation', version = version + 1
   WHERE id = p_request_id;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, resource_id)
  VALUES (p_audit_id, v_invitation.tenant_id,
    v_invitation.requested_by_identity_id,
    'administrator.invitation_delivered', v_invitation.id);
  RETURN QUERY SELECT 'updated'::text, 'pending_activation'::varchar;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_administrator_invitation_delivered(
  uuid, timestamptz, uuid
) FROM PUBLIC;

-- Preserve the reviewed initial-owner/employee activation implementation and
-- wrap it with the new administrator flow without changing its public shape.
ALTER FUNCTION public.resolve_login_identity(
  varchar, varchar, boolean, uuid, uuid, uuid, uuid, uuid
) RENAME TO resolve_login_identity_pre_administrator;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinto_app') THEN
    REVOKE ALL ON FUNCTION public.resolve_login_identity_pre_administrator(
      varchar, varchar, boolean, uuid, uuid, uuid, uuid, uuid
    ) FROM kinto_app;
  END IF;
END $$;
CREATE FUNCTION public.resolve_login_identity(
  p_issuer varchar,
  p_subject varchar,
  p_mfa_verified boolean,
  p_invitation_id uuid,
  p_membership_id uuid,
  p_tenant_audit_id uuid,
  p_platform_audit_id uuid,
  p_employee_link_id uuid
) RETURNS TABLE (
  identity_id uuid,
  owner_activated boolean,
  employee_activated boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result record;
  v_admin record;
BEGIN
  SELECT * INTO v_result FROM public.resolve_login_identity_pre_administrator(
    p_issuer, p_subject, p_mfa_verified, p_invitation_id, p_membership_id,
    p_tenant_audit_id, p_platform_audit_id, p_employee_link_id
  );
  IF NOT FOUND THEN RETURN; END IF;
  IF v_result.owner_activated OR v_result.employee_activated
     OR p_mfa_verified IS DISTINCT FROM true THEN
    RETURN QUERY SELECT v_result.identity_id,
      v_result.owner_activated, v_result.employee_activated;
    RETURN;
  END IF;

  SELECT ai.id, ai.tenant_id, ai.status, ai.expires_at,
         r.id AS request_id, r.status AS request_status, r.roles
    INTO v_admin
    FROM public.administrator_invitations ai
    JOIN public.administrator_account_requests r ON r.id = ai.request_id
    JOIN public.tenants t ON t.id = ai.tenant_id
   WHERE ai.identity_id = v_result.identity_id
     AND t.status = 'active'
     AND ((p_invitation_id IS NOT NULL AND ai.id = p_invitation_id)
       OR (p_invitation_id IS NULL AND ai.status = 'pending_activation'))
   ORDER BY ai.created_at LIMIT 1
   FOR UPDATE OF ai, r;
  IF NOT FOUND
     OR v_admin.status <> 'pending_activation'
     OR v_admin.request_status <> 'pending_activation'
     OR v_admin.expires_at <= pg_catalog.now()
     OR EXISTS (SELECT 1 FROM public.memberships m
       WHERE m.tenant_id = v_admin.tenant_id
         AND m.identity_id = v_result.identity_id) THEN
    RETURN QUERY SELECT v_result.identity_id, false, false;
    RETURN;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_admin.tenant_id::text, 0)
  );
  INSERT INTO public.memberships(id, tenant_id, identity_id, roles)
  VALUES (p_membership_id, v_admin.tenant_id, v_result.identity_id, v_admin.roles);
  UPDATE public.administrator_invitations
     SET status = 'accepted', accepted_at = pg_catalog.now(), version = version + 1
   WHERE id = v_admin.id;
  UPDATE public.administrator_account_requests
     SET status = 'active', version = version + 1
   WHERE id = v_admin.request_id;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, resource_id)
  VALUES (p_tenant_audit_id, v_admin.tenant_id, v_result.identity_id,
    'administrator.account_activated', p_membership_id);
  RETURN QUERY SELECT v_result.identity_id, false, false;
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_login_identity(
  varchar, varchar, boolean, uuid, uuid, uuid, uuid, uuid
) FROM PUBLIC;

COMMIT;
