BEGIN;

CREATE TABLE public.legal_entities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE RESTRICT,
  legal_name varchar(160) NOT NULL CHECK (length(btrim(legal_name)) > 0),
  registration_number varchar(80),
  tax_number varchar(80),
  country_code char(2) NOT NULL DEFAULT 'PK' CHECK (country_code = 'PK'),
  currency_code char(3) NOT NULL DEFAULT 'PKR' CHECK (currency_code = 'PKR'),
  time_zone varchar(64) NOT NULL DEFAULT 'Asia/Karachi' CHECK (time_zone = 'Asia/Karachi'),
  province_code varchar(5) NOT NULL CHECK (province_code IN ('PK-BA', 'PK-GB', 'PK-IS', 'PK-JK', 'PK-KP', 'PK-PB', 'PK-SD')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE public.branches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  legal_entity_id uuid NOT NULL,
  code varchar(20) NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name varchar(160) NOT NULL CHECK (length(btrim(name)) > 0),
  province_code varchar(5) NOT NULL CHECK (province_code IN ('PK-BA', 'PK-GB', 'PK-IS', 'PK-JK', 'PK-KP', 'PK-PB', 'PK-SD')),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, legal_entity_id)
    REFERENCES public.legal_entities(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX branches_tenant_status_idx ON public.branches(tenant_id, status);

CREATE TABLE public.company_policy_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  domain varchar(50) NOT NULL CHECK (domain = 'organization_defaults'),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  based_on_version integer NOT NULL CHECK (based_on_version >= 0 AND based_on_version < policy_version),
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  effective_from date NOT NULL,
  settings jsonb NOT NULL CHECK (
    jsonb_typeof(settings) = 'object'
    AND settings ? 'defaultBranchId'
    AND jsonb_typeof(settings->'defaultBranchId') = 'string'
    AND settings = jsonb_build_object('defaultBranchId', settings->'defaultBranchId')
    AND (settings->>'defaultBranchId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  reason varchar(240) NOT NULL CHECK (length(btrim(reason)) >= 3),
  created_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  published_by_identity_id uuid REFERENCES public.identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, domain, policy_version),
  CHECK ((status = 'draft' AND published_by_identity_id IS NULL AND published_at IS NULL)
      OR (status = 'published' AND published_by_identity_id IS NOT NULL AND published_at IS NOT NULL))
);
CREATE UNIQUE INDEX company_policy_published_effective_key
  ON public.company_policy_versions(tenant_id, domain, effective_from)
  WHERE status = 'published';
CREATE INDEX company_policy_resolution_idx
  ON public.company_policy_versions(tenant_id, domain, status, effective_from DESC, policy_version DESC);

ALTER TABLE public.legal_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.legal_entities
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.branches
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE public.company_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.company_policy_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION public.tenant_organization_authorized(
  p_actor_identity_id uuid,
  p_mfa_verified boolean,
  p_tenant_id uuid,
  p_manage boolean
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_mfa_verified IS TRUE AND EXISTS (
    SELECT 1
      FROM public.identities i
      JOIN public.memberships m ON m.identity_id = i.id
      JOIN public.tenants t ON t.id = m.tenant_id
     WHERE i.id = p_actor_identity_id
       AND i.status = 'active'
       AND m.tenant_id = p_tenant_id
       AND m.status = 'active'
       AND (('owner' = ANY(m.roles)) OR (p_manage IS FALSE AND 'hr_admin' = ANY(m.roles)))
       AND t.status = 'active'
  )
$$;
REVOKE ALL ON FUNCTION public.tenant_organization_authorized(uuid, boolean, uuid, boolean) FROM PUBLIC;

CREATE FUNCTION public.read_tenant_organization(
  p_actor_identity_id uuid,
  p_mfa_verified boolean,
  p_tenant_id uuid
) RETURNS TABLE (outcome text, snapshot jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.tenant_organization_authorized(
    p_actor_identity_id, p_mfa_verified, p_tenant_id, false
  ) THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::jsonb;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ok'::text, jsonb_build_object(
    'legalEntity', (
      SELECT jsonb_build_object(
        'id', le.id, 'legalName', le.legal_name,
        'registrationNumber', le.registration_number, 'taxNumber', le.tax_number,
        'countryCode', le.country_code, 'currencyCode', le.currency_code,
        'timeZone', le.time_zone, 'provinceCode', le.province_code,
        'version', le.version
      ) FROM public.legal_entities le WHERE le.tenant_id = p_tenant_id
    ),
    'branches', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'legalEntityId', b.legal_entity_id, 'code', b.code,
        'name', b.name, 'provinceCode', b.province_code,
        'status', b.status, 'version', b.version
      ) ORDER BY (b.status = 'active') DESC, b.code, b.id)
      FROM public.branches b WHERE b.tenant_id = p_tenant_id
    ), '[]'::jsonb),
    'latestPublishedVersion', (
      SELECT COALESCE(max(cp.policy_version), 0)
      FROM public.company_policy_versions cp
      WHERE cp.tenant_id = p_tenant_id
        AND cp.domain = 'organization_defaults'
        AND cp.status = 'published'
    ),
    'publishedPolicy', (
      SELECT jsonb_build_object(
        'id', cp.id, 'version', cp.policy_version,
        'effectiveFrom', to_char(cp.effective_from, 'YYYY-MM-DD'),
        'settings', cp.settings
      ) FROM public.company_policy_versions cp
      WHERE cp.tenant_id = p_tenant_id
        AND cp.domain = 'organization_defaults'
        AND cp.status = 'published'
        AND cp.effective_from <= (now() AT TIME ZONE 'Asia/Karachi')::date
      ORDER BY cp.effective_from DESC, cp.policy_version DESC LIMIT 1
    ),
    'policyDrafts', COALESCE((
      SELECT jsonb_agg(d.item ORDER BY d.policy_version DESC)
      FROM (
        SELECT cp.policy_version, jsonb_build_object(
          'id', cp.id, 'version', cp.policy_version,
          'basedOnVersion', cp.based_on_version,
          'effectiveFrom', to_char(cp.effective_from, 'YYYY-MM-DD'),
          'settings', cp.settings, 'reason', cp.reason
        ) AS item
        FROM public.company_policy_versions cp
        WHERE cp.tenant_id = p_tenant_id
          AND cp.domain = 'organization_defaults' AND cp.status = 'draft'
        ORDER BY cp.policy_version DESC LIMIT 20
      ) d
    ), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.read_tenant_organization(uuid, boolean, uuid) FROM PUBLIC;

CREATE FUNCTION public.create_tenant_legal_entity(
  p_actor_identity_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_entity_id uuid, p_legal_name varchar, p_registration_number varchar,
  p_tax_number varchar, p_province_code varchar, p_reason varchar,
  p_audit_id uuid, p_outbox_id uuid
) RETURNS TABLE (outcome text, entity_id uuid, entity_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.tenant_organization_authorized(
    p_actor_identity_id, p_mfa_verified, p_tenant_id, true
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':legal_entity', 0));
  IF EXISTS (SELECT 1 FROM public.legal_entities WHERE tenant_id = p_tenant_id) THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_legal_name IS NULL OR length(btrim(p_legal_name)) < 1 OR length(p_legal_name) > 160
     OR p_province_code IS NULL OR p_province_code NOT IN ('PK-BA', 'PK-GB', 'PK-IS', 'PK-JK', 'PK-KP', 'PK-PB', 'PK-SD')
     OR p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 240 THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  INSERT INTO public.legal_entities(
    id, tenant_id, legal_name, registration_number, tax_number, province_code
  ) VALUES (
    p_entity_id, p_tenant_id, p_legal_name, p_registration_number,
    p_tax_number, p_province_code
  );
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit_id, p_tenant_id, p_actor_identity_id,
      'legal_entity.created', p_reason, p_entity_id);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox_id, p_tenant_id, 'legal_entity.created.v1', p_entity_id, 1);
  RETURN QUERY SELECT 'created'::text, p_entity_id, 1;
END;
$$;
REVOKE ALL ON FUNCTION public.create_tenant_legal_entity(uuid, boolean, uuid, uuid, varchar, varchar, varchar, varchar, varchar, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION public.update_tenant_legal_entity(
  p_actor_identity_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_entity_id uuid, p_expected_version integer, p_legal_name varchar,
  p_registration_number varchar, p_tax_number varchar, p_province_code varchar,
  p_reason varchar, p_audit_id uuid, p_outbox_id uuid
) RETURNS TABLE (outcome text, entity_id uuid, entity_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_entity public.legal_entities%ROWTYPE; v_version integer;
BEGIN
  IF NOT public.tenant_organization_authorized(
    p_actor_identity_id, p_mfa_verified, p_tenant_id, true
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT * INTO v_entity FROM public.legal_entities
    WHERE tenant_id = p_tenant_id AND id = p_entity_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_expected_version IS NULL OR v_entity.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_legal_name IS NULL OR length(btrim(p_legal_name)) < 1 OR length(p_legal_name) > 160
     OR p_province_code IS NULL OR p_province_code NOT IN ('PK-BA', 'PK-GB', 'PK-IS', 'PK-JK', 'PK-KP', 'PK-PB', 'PK-SD')
     OR p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 240 THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF v_entity.legal_name = p_legal_name
     AND v_entity.registration_number IS NOT DISTINCT FROM p_registration_number
     AND v_entity.tax_number IS NOT DISTINCT FROM p_tax_number
     AND v_entity.province_code = p_province_code THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  UPDATE public.legal_entities SET legal_name = p_legal_name,
    registration_number = p_registration_number, tax_number = p_tax_number,
    province_code = p_province_code, version = version + 1, updated_at = now()
    WHERE tenant_id = p_tenant_id AND id = p_entity_id RETURNING version INTO v_version;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit_id, p_tenant_id, p_actor_identity_id,
      'legal_entity.updated', p_reason, p_entity_id);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox_id, p_tenant_id, 'legal_entity.updated.v1', p_entity_id, v_version);
  RETURN QUERY SELECT 'updated'::text, p_entity_id, v_version;
END;
$$;
REVOKE ALL ON FUNCTION public.update_tenant_legal_entity(uuid, boolean, uuid, uuid, integer, varchar, varchar, varchar, varchar, varchar, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION public.create_tenant_branch(
  p_actor_identity_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_branch_id uuid, p_code varchar, p_name varchar, p_province_code varchar,
  p_reason varchar, p_audit_id uuid, p_outbox_id uuid
) RETURNS TABLE (outcome text, branch_id uuid, branch_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_entity_id uuid;
BEGIN
  IF NOT public.tenant_organization_authorized(
    p_actor_identity_id, p_mfa_verified, p_tenant_id, true
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT id INTO v_entity_id FROM public.legal_entities
    WHERE tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'invalid_state'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_code IS NULL OR p_code !~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'
     OR p_name IS NULL OR length(btrim(p_name)) < 1 OR length(p_name) > 160
     OR p_province_code IS NULL OR p_province_code NOT IN ('PK-BA', 'PK-GB', 'PK-IS', 'PK-JK', 'PK-KP', 'PK-PB', 'PK-SD')
     OR p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 240
     OR EXISTS (SELECT 1 FROM public.branches WHERE tenant_id = p_tenant_id AND code = p_code) THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  INSERT INTO public.branches(id, tenant_id, legal_entity_id, code, name, province_code)
    VALUES (p_branch_id, p_tenant_id, v_entity_id, p_code, p_name, p_province_code);
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit_id, p_tenant_id, p_actor_identity_id, 'branch.created', p_reason, p_branch_id);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox_id, p_tenant_id, 'branch.created.v1', p_branch_id, 1);
  RETURN QUERY SELECT 'created'::text, p_branch_id, 1;
END;
$$;
REVOKE ALL ON FUNCTION public.create_tenant_branch(uuid, boolean, uuid, uuid, varchar, varchar, varchar, varchar, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION public.update_tenant_branch(
  p_actor_identity_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_branch_id uuid, p_expected_version integer, p_code varchar, p_name varchar,
  p_province_code varchar, p_status varchar, p_reason varchar,
  p_audit_id uuid, p_outbox_id uuid
) RETURNS TABLE (outcome text, branch_id uuid, branch_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_branch public.branches%ROWTYPE; v_version integer; v_today date;
BEGIN
  IF NOT public.tenant_organization_authorized(
    p_actor_identity_id, p_mfa_verified, p_tenant_id, true
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT * INTO v_branch FROM public.branches
    WHERE tenant_id = p_tenant_id AND id = p_branch_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_expected_version IS NULL OR v_branch.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_code IS NULL OR p_code !~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'
     OR p_name IS NULL OR length(btrim(p_name)) < 1 OR length(p_name) > 160
     OR p_province_code IS NULL OR p_province_code NOT IN ('PK-BA', 'PK-GB', 'PK-IS', 'PK-JK', 'PK-KP', 'PK-PB', 'PK-SD')
     OR p_status IS NULL OR p_status NOT IN ('active', 'inactive')
     OR p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 240
     OR EXISTS (SELECT 1 FROM public.branches
       WHERE tenant_id = p_tenant_id AND code = p_code AND id <> p_branch_id) THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF v_branch.code = p_code AND v_branch.name = p_name
     AND v_branch.province_code = p_province_code AND v_branch.status = p_status THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;
  IF p_status = 'inactive' AND v_branch.status = 'active' AND EXISTS (
    SELECT 1 FROM public.company_policy_versions cp
    WHERE cp.tenant_id = p_tenant_id AND cp.domain = 'organization_defaults'
      AND cp.status = 'published' AND (cp.settings->>'defaultBranchId')::uuid = p_branch_id
      AND (cp.effective_from >= v_today OR cp.id = (
        SELECT current_cp.id FROM public.company_policy_versions current_cp
        WHERE current_cp.tenant_id = p_tenant_id
          AND current_cp.domain = 'organization_defaults'
          AND current_cp.status = 'published' AND current_cp.effective_from <= v_today
        ORDER BY current_cp.effective_from DESC, current_cp.policy_version DESC LIMIT 1
      ))
  ) THEN RETURN QUERY SELECT 'invalid_state'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  UPDATE public.branches SET code = p_code, name = p_name,
    province_code = p_province_code, status = p_status,
    version = version + 1, updated_at = now()
    WHERE tenant_id = p_tenant_id AND id = p_branch_id RETURNING version INTO v_version;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit_id, p_tenant_id, p_actor_identity_id, 'branch.updated', p_reason, p_branch_id);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox_id, p_tenant_id, 'branch.updated.v1', p_branch_id, v_version);
  RETURN QUERY SELECT 'updated'::text, p_branch_id, v_version;
END;
$$;
REVOKE ALL ON FUNCTION public.update_tenant_branch(uuid, boolean, uuid, uuid, integer, varchar, varchar, varchar, varchar, varchar, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION public.create_organization_policy_draft(
  p_actor_identity_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_policy_id uuid, p_expected_current_version integer, p_effective_from date,
  p_default_branch_id uuid, p_reason varchar, p_audit_id uuid
) RETURNS TABLE (outcome text, policy_id uuid, policy_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_current integer; v_next integer; v_today date;
BEGIN
  IF NOT public.tenant_organization_authorized(
    p_actor_identity_id, p_mfa_verified, p_tenant_id, true
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':organization_defaults', 0));
  SELECT COALESCE(max(cp.policy_version), 0) INTO v_current
    FROM public.company_policy_versions cp WHERE cp.tenant_id = p_tenant_id
      AND cp.domain = 'organization_defaults' AND cp.status = 'published';
  IF p_expected_current_version IS NULL OR p_expected_current_version <> v_current THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  v_today := (now() AT TIME ZONE 'Asia/Karachi')::date;
  IF p_effective_from IS NULL OR p_effective_from < v_today
     OR p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 240
     OR NOT EXISTS (SELECT 1 FROM public.branches
       WHERE tenant_id = p_tenant_id AND id = p_default_branch_id AND status = 'active')
     OR EXISTS (SELECT 1 FROM public.company_policy_versions
       WHERE tenant_id = p_tenant_id AND domain = 'organization_defaults'
         AND status = 'published' AND effective_from >= p_effective_from) THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT COALESCE(max(cp.policy_version), 0) + 1 INTO v_next
    FROM public.company_policy_versions cp WHERE cp.tenant_id = p_tenant_id
      AND cp.domain = 'organization_defaults';
  INSERT INTO public.company_policy_versions(
    id, tenant_id, domain, policy_version, based_on_version, effective_from,
    settings, reason, created_by_identity_id
  ) VALUES (
    p_policy_id, p_tenant_id, 'organization_defaults', v_next, v_current,
    p_effective_from, jsonb_build_object('defaultBranchId', p_default_branch_id),
    p_reason, p_actor_identity_id
  );
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit_id, p_tenant_id, p_actor_identity_id,
      'company_policy.draft_created', p_reason, p_policy_id);
  RETURN QUERY SELECT 'created'::text, p_policy_id, v_next;
END;
$$;
REVOKE ALL ON FUNCTION public.create_organization_policy_draft(uuid, boolean, uuid, uuid, integer, date, uuid, varchar, uuid) FROM PUBLIC;

CREATE FUNCTION public.preview_organization_policy(
  p_actor_identity_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_policy_id uuid
) RETURNS TABLE (outcome text, preview jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.tenant_organization_authorized(
    p_actor_identity_id, p_mfa_verified, p_tenant_id, false
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::jsonb; RETURN;
  END IF;
  RETURN QUERY
    SELECT 'ok'::text, jsonb_build_object(
      'id', cp.id, 'version', cp.policy_version,
      'basedOnVersion', cp.based_on_version,
      'effectiveFrom', to_char(cp.effective_from, 'YYYY-MM-DD'),
      'defaultBranch', jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name),
      'affectedOpenPeriods', '[]'::jsonb
    )
    FROM public.company_policy_versions cp
    JOIN public.branches b ON b.tenant_id = cp.tenant_id
      AND b.id = (cp.settings->>'defaultBranchId')::uuid
    WHERE cp.tenant_id = p_tenant_id AND cp.id = p_policy_id
      AND cp.domain = 'organization_defaults' AND cp.status = 'draft';
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::jsonb;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.preview_organization_policy(uuid, boolean, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION public.publish_organization_policy(
  p_actor_identity_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_policy_id uuid, p_expected_version integer, p_reason varchar,
  p_audit_id uuid, p_outbox_id uuid
) RETURNS TABLE (outcome text, policy_id uuid, policy_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_policy public.company_policy_versions%ROWTYPE; v_current integer;
BEGIN
  IF NOT public.tenant_organization_authorized(
    p_actor_identity_id, p_mfa_verified, p_tenant_id, true
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':organization_defaults', 0));
  SELECT * INTO v_policy FROM public.company_policy_versions
    WHERE tenant_id = p_tenant_id AND id = p_policy_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_expected_version IS NULL OR v_policy.status <> 'draft'
     OR v_policy.policy_version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT COALESCE(max(cp.policy_version), 0) INTO v_current
    FROM public.company_policy_versions cp WHERE cp.tenant_id = p_tenant_id
      AND cp.domain = 'organization_defaults' AND cp.status = 'published';
  IF v_current <> v_policy.based_on_version THEN
    RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 240
     OR v_policy.effective_from < (now() AT TIME ZONE 'Asia/Karachi')::date
     OR NOT EXISTS (SELECT 1 FROM public.branches
       WHERE tenant_id = p_tenant_id
         AND id = (v_policy.settings->>'defaultBranchId')::uuid AND status = 'active')
     OR EXISTS (SELECT 1 FROM public.company_policy_versions
       WHERE tenant_id = p_tenant_id AND domain = 'organization_defaults'
         AND status = 'published' AND effective_from = v_policy.effective_from) THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  UPDATE public.company_policy_versions SET status = 'published',
    published_by_identity_id = p_actor_identity_id, published_at = now()
    WHERE tenant_id = p_tenant_id AND id = p_policy_id;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit_id, p_tenant_id, p_actor_identity_id,
      'company_policy.published', p_reason, p_policy_id);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox_id, p_tenant_id, 'company_policy.published.v1',
      p_policy_id, v_policy.policy_version);
  RETURN QUERY SELECT 'published'::text, p_policy_id, v_policy.policy_version;
END;
$$;
REVOKE ALL ON FUNCTION public.publish_organization_policy(uuid, boolean, uuid, uuid, integer, varchar, uuid, uuid) FROM PUBLIC;

COMMIT;
