BEGIN;

CREATE TABLE public.departments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  code varchar(20) NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name varchar(160) NOT NULL CHECK (length(btrim(name)) > 0),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
CREATE INDEX departments_tenant_status_idx ON public.departments(tenant_id, status);

CREATE TABLE public.designations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  code varchar(20) NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name varchar(160) NOT NULL CHECK (length(btrim(name)) > 0),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
CREATE INDEX designations_tenant_status_idx ON public.designations(tenant_id, status);

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.departments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE public.designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.designations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.designations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION public.mutate_organization_catalog(
  p_actor_identity_id uuid, p_mfa_verified boolean, p_tenant_id uuid,
  p_catalog varchar, p_resource_id uuid, p_expected_version integer,
  p_code varchar, p_name varchar, p_status varchar, p_reason varchar,
  p_audit_id uuid, p_outbox_id uuid
) RETURNS TABLE (outcome text, resource_id uuid, resource_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_version integer; v_existing_code varchar; v_existing_name varchar; v_existing_status varchar;
BEGIN
  IF NOT public.tenant_organization_authorized(
    p_actor_identity_id, p_mfa_verified, p_tenant_id, true
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_catalog NOT IN ('department', 'designation')
     OR p_code IS NULL OR p_code !~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'
     OR p_name IS NULL OR length(btrim(p_name)) < 1 OR length(p_name) > 160
     OR p_status IS NULL OR p_status NOT IN ('active', 'inactive')
     OR p_reason IS NULL OR length(btrim(p_reason)) < 3 OR length(p_reason) > 240 THEN
    RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_catalog, 0));

  IF p_expected_version IS NULL THEN
    IF p_status <> 'active' THEN
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
    END IF;
    IF p_catalog = 'department' THEN
      IF EXISTS (SELECT 1 FROM public.departments WHERE tenant_id = p_tenant_id AND code = p_code) THEN
        RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
      END IF;
      INSERT INTO public.departments(id, tenant_id, code, name)
        VALUES (p_resource_id, p_tenant_id, p_code, p_name);
    ELSE
      IF EXISTS (SELECT 1 FROM public.designations WHERE tenant_id = p_tenant_id AND code = p_code) THEN
        RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
      END IF;
      INSERT INTO public.designations(id, tenant_id, code, name)
        VALUES (p_resource_id, p_tenant_id, p_code, p_name);
    END IF;
    v_version := 1;
  ELSE
    IF p_catalog = 'department' THEN
      SELECT code, name, status, version INTO v_existing_code, v_existing_name, v_existing_status, v_version
        FROM public.departments WHERE tenant_id = p_tenant_id AND id = p_resource_id FOR UPDATE;
    ELSE
      SELECT code, name, status, version INTO v_existing_code, v_existing_name, v_existing_status, v_version
        FROM public.designations WHERE tenant_id = p_tenant_id AND id = p_resource_id FOR UPDATE;
    END IF;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::integer; RETURN; END IF;
    IF v_version <> p_expected_version THEN
      RETURN QUERY SELECT 'stale'::text, NULL::uuid, NULL::integer; RETURN;
    END IF;
    IF v_existing_code = p_code AND v_existing_name = p_name AND v_existing_status = p_status THEN
      RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
    END IF;
    IF p_catalog = 'department' THEN
      IF EXISTS (SELECT 1 FROM public.departments
        WHERE tenant_id = p_tenant_id AND code = p_code AND id <> p_resource_id) THEN
        RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
      END IF;
      UPDATE public.departments SET code = p_code, name = p_name, status = p_status,
        version = version + 1, updated_at = now()
        WHERE tenant_id = p_tenant_id AND id = p_resource_id RETURNING version INTO v_version;
    ELSE
      IF EXISTS (SELECT 1 FROM public.designations
        WHERE tenant_id = p_tenant_id AND code = p_code AND id <> p_resource_id) THEN
        RETURN QUERY SELECT 'conflict'::text, NULL::uuid, NULL::integer; RETURN;
      END IF;
      UPDATE public.designations SET code = p_code, name = p_name, status = p_status,
        version = version + 1, updated_at = now()
        WHERE tenant_id = p_tenant_id AND id = p_resource_id RETURNING version INTO v_version;
    END IF;
  END IF;

  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit_id, p_tenant_id, p_actor_identity_id,
      p_catalog || CASE WHEN p_expected_version IS NULL THEN '.created' ELSE '.updated' END,
      p_reason, p_resource_id);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox_id, p_tenant_id,
      p_catalog || CASE WHEN p_expected_version IS NULL THEN '.created.v1' ELSE '.updated.v1' END,
      p_resource_id, v_version);
  RETURN QUERY SELECT CASE WHEN p_expected_version IS NULL THEN 'created' ELSE 'updated' END,
    p_resource_id, v_version;
END;
$$;
REVOKE ALL ON FUNCTION public.mutate_organization_catalog(uuid, boolean, uuid, varchar, uuid, integer, varchar, varchar, varchar, varchar, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.read_tenant_organization(
  p_actor_identity_id uuid, p_mfa_verified boolean, p_tenant_id uuid
) RETURNS TABLE (outcome text, snapshot jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.tenant_organization_authorized(
    p_actor_identity_id, p_mfa_verified, p_tenant_id, false
  ) THEN RETURN QUERY SELECT 'forbidden'::text, NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::text, jsonb_build_object(
    'legalEntity', (SELECT jsonb_build_object(
      'id', le.id, 'legalName', le.legal_name,
      'registrationNumber', le.registration_number, 'taxNumber', le.tax_number,
      'countryCode', le.country_code, 'currencyCode', le.currency_code,
      'timeZone', le.time_zone, 'provinceCode', le.province_code, 'version', le.version
    ) FROM public.legal_entities le WHERE le.tenant_id = p_tenant_id),
    'branches', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', b.id, 'legalEntityId', b.legal_entity_id, 'code', b.code,
      'name', b.name, 'provinceCode', b.province_code, 'status', b.status, 'version', b.version
    ) ORDER BY (b.status = 'active') DESC, b.code, b.id)
      FROM public.branches b WHERE b.tenant_id = p_tenant_id), '[]'::jsonb),
    'departments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', d.id, 'code', d.code, 'name', d.name, 'status', d.status, 'version', d.version
    ) ORDER BY (d.status = 'active') DESC, d.code, d.id)
      FROM public.departments d WHERE d.tenant_id = p_tenant_id), '[]'::jsonb),
    'designations', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', d.id, 'code', d.code, 'name', d.name, 'status', d.status, 'version', d.version
    ) ORDER BY (d.status = 'active') DESC, d.code, d.id)
      FROM public.designations d WHERE d.tenant_id = p_tenant_id), '[]'::jsonb),
    'latestPublishedVersion', (SELECT COALESCE(max(cp.policy_version), 0)
      FROM public.company_policy_versions cp WHERE cp.tenant_id = p_tenant_id
        AND cp.domain = 'organization_defaults' AND cp.status = 'published'),
    'publishedPolicy', (SELECT jsonb_build_object(
      'id', cp.id, 'version', cp.policy_version,
      'effectiveFrom', to_char(cp.effective_from, 'YYYY-MM-DD'), 'settings', cp.settings
    ) FROM public.company_policy_versions cp WHERE cp.tenant_id = p_tenant_id
      AND cp.domain = 'organization_defaults' AND cp.status = 'published'
      AND cp.effective_from <= (now() AT TIME ZONE 'Asia/Karachi')::date
      ORDER BY cp.effective_from DESC, cp.policy_version DESC LIMIT 1),
    'policyDrafts', COALESCE((SELECT jsonb_agg(d.item ORDER BY d.policy_version DESC)
      FROM (SELECT cp.policy_version, jsonb_build_object(
        'id', cp.id, 'version', cp.policy_version, 'basedOnVersion', cp.based_on_version,
        'effectiveFrom', to_char(cp.effective_from, 'YYYY-MM-DD'),
        'settings', cp.settings, 'reason', cp.reason
      ) AS item FROM public.company_policy_versions cp
      WHERE cp.tenant_id = p_tenant_id AND cp.domain = 'organization_defaults'
        AND cp.status = 'draft' ORDER BY cp.policy_version DESC LIMIT 20) d), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.read_tenant_organization(uuid, boolean, uuid) FROM PUBLIC;

COMMIT;
