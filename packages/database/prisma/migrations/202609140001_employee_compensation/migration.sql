BEGIN;

CREATE TABLE public.compensation_agreements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'PKR' CHECK (currency_code='PKR'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES public.employees(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.salary_components (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  agreement_id uuid NOT NULL,
  code varchar(30) NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, agreement_id, code),
  UNIQUE (tenant_id, agreement_id, id),
  FOREIGN KEY (tenant_id, agreement_id) REFERENCES public.compensation_agreements(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.compensation_component_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  agreement_id uuid NOT NULL,
  component_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  name varchar(100) NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  kind varchar(20) NOT NULL CHECK (kind IN ('basic_salary','allowance','deduction')),
  monthly_amount numeric(15,2) NOT NULL CHECK (monthly_amount > 0),
  effective_from date NOT NULL,
  effective_to date,
  reason varchar(240) NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 240),
  created_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, agreement_id, revision, component_id),
  FOREIGN KEY (tenant_id, agreement_id, component_id) REFERENCES public.salary_components(tenant_id, agreement_id, id) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX compensation_versions_effective ON public.compensation_component_versions(tenant_id, agreement_id, effective_from);

ALTER TABLE public.compensation_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compensation_agreements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.salary_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_components FORCE ROW LEVEL SECURITY;
ALTER TABLE public.compensation_component_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compensation_component_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.compensation_agreements USING (tenant_id=nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON public.salary_components USING (tenant_id=nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_scope ON public.compensation_component_versions USING (tenant_id=nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION public.reject_compensation_version_overlap() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.compensation_component_versions v
    WHERE v.tenant_id=NEW.tenant_id AND v.component_id=NEW.component_id AND v.id<>NEW.id
      AND daterange(v.effective_from, COALESCE(v.effective_to, 'infinity'::date), '[]') &&
          daterange(NEW.effective_from, COALESCE(NEW.effective_to, 'infinity'::date), '[]')) THEN
    RAISE EXCEPTION 'overlapping compensation component version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compensation_version_no_overlap BEFORE INSERT OR UPDATE ON public.compensation_component_versions
  FOR EACH ROW EXECUTE FUNCTION public.reject_compensation_version_overlap();

CREATE FUNCTION public.tenant_compensation_authorized(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_write boolean
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog, public AS $$
  SELECT p_mfa_verified AND EXISTS (
    SELECT 1 FROM public.tenants t JOIN public.memberships m ON m.tenant_id=t.id
      JOIN public.identities i ON i.id=m.identity_id
    WHERE t.id=p_tenant AND t.status='active' AND i.id=p_actor AND i.status='active'
      AND m.status='active' AND (
        (p_write AND 'payroll_preparer'=ANY(m.roles)) OR
        (NOT p_write AND m.roles && ARRAY['payroll_preparer','payroll_approver']::text[])
      )
  )
$$;

CREATE FUNCTION public.read_tenant_employee_compensation(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid
) RETURNS TABLE(outcome varchar, snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public AS $$
DECLARE result jsonb;
BEGIN
  IF NOT public.tenant_compensation_authorized(p_actor,p_mfa_verified,p_tenant,false) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::jsonb; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant
    AND e.id=p_employee AND e.joining_date IS NOT NULL) THEN
    RETURN QUERY SELECT 'not_found'::varchar, NULL::jsonb; RETURN;
  END IF;
  SELECT jsonb_build_object(
    'id', a.id, 'employeeId', a.employee_id, 'currencyCode', a.currency_code,
    'version', a.version, 'revisions', (
      SELECT jsonb_agg(jsonb_build_object(
        'revision', revision_set.revision,
        'effectiveFrom', to_char(revision_set.effective_from,'YYYY-MM-DD'),
        'effectiveTo', CASE WHEN revision_set.effective_to IS NULL THEN NULL ELSE to_char(revision_set.effective_to,'YYYY-MM-DD') END,
        'components', revision_set.components,
        'createdAt', revision_set.created_at
      ) ORDER BY revision_set.revision DESC)
      FROM (
        SELECT v.revision, min(v.effective_from) effective_from,
          max(v.effective_to) effective_to, max(v.created_at) created_at,
          jsonb_agg(jsonb_build_object('code',c.code,'name',v.name,'kind',v.kind,
            'monthlyAmount',v.monthly_amount::text) ORDER BY
            CASE v.kind WHEN 'basic_salary' THEN 0 WHEN 'allowance' THEN 1 ELSE 2 END,c.code) components
        FROM public.compensation_component_versions v
        JOIN public.salary_components c ON c.tenant_id=v.tenant_id AND c.id=v.component_id
        WHERE v.tenant_id=a.tenant_id AND v.agreement_id=a.id GROUP BY v.revision
      ) revision_set
    )
  ) INTO result FROM public.compensation_agreements a
    WHERE a.tenant_id=p_tenant AND a.employee_id=p_employee;
  RETURN QUERY SELECT 'ok'::varchar, jsonb_build_object('agreement',result);
END $$;

CREATE OR REPLACE FUNCTION public.revise_tenant_employee_compensation(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid,
  p_agreement uuid, p_expected_version integer, p_effective_from date,
  p_components jsonb, p_reason varchar, p_audit uuid, p_outbox uuid
) RETURNS TABLE(outcome varchar, agreement_id uuid, agreement_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public AS $$
DECLARE current_agreement public.compensation_agreements%ROWTYPE;
  current_employee public.employees%ROWTYPE; next_version integer;
BEGIN
  IF NOT public.tenant_compensation_authorized(p_actor,p_mfa_verified,p_tenant,true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  IF p_expected_version<0 OR p_effective_from IS NULL OR p_reason IS NULL OR
    length(btrim(p_reason)) NOT BETWEEN 3 AND 240 OR jsonb_typeof(p_components)<>'array' OR
    jsonb_array_length(p_components) NOT BETWEEN 1 AND 30 OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_components) item WHERE
        jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>5 OR
        NOT (item ?& ARRAY['id','code','name','kind','monthlyAmount']) OR
        item->>'code' !~ '^[A-Z][A-Z0-9_]{0,29}$' OR
        length(btrim(item->>'name')) NOT BETWEEN 1 AND 100 OR
        item->>'kind' NOT IN ('basic_salary','allowance','deduction') OR
        item->>'monthlyAmount' !~ '^(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$' OR
        (item->>'monthlyAmount')::numeric<=0
    ) OR (SELECT count(*) FROM jsonb_array_elements(p_components) item
      WHERE item->>'kind'='basic_salary')<>1 OR (SELECT count(DISTINCT item->>'code')
      FROM jsonb_array_elements(p_components) item)<>jsonb_array_length(p_components) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  SELECT e.* INTO current_employee FROM public.employees e WHERE e.tenant_id=p_tenant
    AND e.id=p_employee AND e.joining_date IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::uuid,NULL::integer; RETURN; END IF;
  IF current_employee.status NOT IN ('draft','active') OR p_effective_from<current_employee.joining_date THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  SELECT a.* INTO current_agreement FROM public.compensation_agreements a
    WHERE a.tenant_id=p_tenant AND a.employee_id=p_employee FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_version<>0 THEN RETURN QUERY SELECT 'stale'::varchar,NULL::uuid,NULL::integer; RETURN; END IF;
    INSERT INTO public.compensation_agreements(id,tenant_id,employee_id)
      VALUES(p_agreement,p_tenant,p_employee);
    next_version:=1;
  ELSE
    IF p_expected_version<>current_agreement.version THEN RETURN QUERY SELECT 'stale'::varchar,NULL::uuid,NULL::integer; RETURN; END IF;
    IF p_effective_from<=(SELECT max(v.effective_from) FROM public.compensation_component_versions v
      WHERE v.tenant_id=p_tenant AND v.agreement_id=current_agreement.id) THEN
      RETURN QUERY SELECT 'conflict'::varchar,NULL::uuid,NULL::integer; RETURN;
    END IF;
    p_agreement:=current_agreement.id; next_version:=current_agreement.version+1;
    UPDATE public.compensation_component_versions v SET effective_to=p_effective_from-1
      WHERE v.tenant_id=p_tenant AND v.agreement_id=p_agreement AND v.effective_to IS NULL;
    UPDATE public.compensation_agreements a SET version=next_version,updated_at=now()
      WHERE a.tenant_id=p_tenant AND a.id=p_agreement;
  END IF;
  INSERT INTO public.salary_components(id,tenant_id,agreement_id,code)
    SELECT x.id,p_tenant,p_agreement,x.code FROM jsonb_to_recordset(p_components)
      AS x(id uuid,code varchar,name varchar,kind varchar,"monthlyAmount" varchar)
    ON CONFLICT DO NOTHING;
  INSERT INTO public.compensation_component_versions(id,tenant_id,agreement_id,component_id,
    revision,name,kind,monthly_amount,effective_from,reason,created_by_identity_id)
    SELECT gen_random_uuid(),p_tenant,p_agreement,c.id,next_version,x.name,x.kind,
      x."monthlyAmount"::numeric,p_effective_from,btrim(p_reason),p_actor
    FROM jsonb_to_recordset(p_components) AS x(id uuid,code varchar,name varchar,kind varchar,"monthlyAmount" varchar)
    JOIN public.salary_components c ON c.tenant_id=p_tenant AND c.agreement_id=p_agreement AND c.code=x.code;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,CASE WHEN next_version=1 THEN 'employee.compensation_created' ELSE 'employee.compensation_revised' END,btrim(p_reason),p_employee);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.compensation_changed.v1',p_employee,next_version);
  RETURN QUERY SELECT 'updated'::varchar,p_agreement,next_version;
END $$;

REVOKE ALL ON FUNCTION public.reject_compensation_version_overlap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_compensation_authorized(uuid,boolean,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_tenant_employee_compensation(uuid,boolean,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revise_tenant_employee_compensation(uuid,boolean,uuid,uuid,uuid,integer,date,jsonb,varchar,uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.employee_record_json(p_tenant uuid, p_employee uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'id', e.id,
    'employeeNumber', e.employee_number,
    'name', e.name,
    'legalName', e.legal_name,
    'status', e.status,
    'version', e.version,
    'joiningDate', to_char(e.joining_date, 'YYYY-MM-DD'),
    'employmentType', e.employment_type,
    'payrollSetup', CASE WHEN EXISTS (SELECT 1 FROM public.compensation_agreements ca WHERE ca.tenant_id=e.tenant_id AND ca.employee_id=e.id) THEN 'complete' ELSE 'incomplete' END,
    'finalWorkingDate', CASE WHEN ep.final_working_date IS NULL THEN NULL
      ELSE to_char(ep.final_working_date, 'YYYY-MM-DD') END,
    'archivedAt', e.archived_at,
    'employmentHistory', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', period.id,
        'periodNumber', period.period_number,
        'joiningDate', to_char(period.joining_date, 'YYYY-MM-DD'),
        'finalWorkingDate', CASE WHEN period.final_working_date IS NULL THEN NULL
          ELSE to_char(period.final_working_date, 'YYYY-MM-DD') END,
        'status', period.status
      ) ORDER BY period.period_number DESC)
      FROM public.employment_periods period
      WHERE period.tenant_id=e.tenant_id AND period.employee_id=e.id
    ), '[]'::jsonb),
    'currentAssignment', (
      SELECT jsonb_build_object(
        'id', a.id,
        'effectiveFrom', to_char(a.effective_from, 'YYYY-MM-DD'),
        'effectiveTo', CASE WHEN a.effective_to IS NULL THEN NULL ELSE to_char(a.effective_to, 'YYYY-MM-DD') END,
        'branch', jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name),
        'department', jsonb_build_object('id', d.id, 'code', d.code, 'name', d.name),
        'designation', jsonb_build_object('id', g.id, 'code', g.code, 'name', g.name),
        'manager', CASE WHEN manager.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', manager.id, 'employeeNumber', manager.employee_number, 'name', manager.name
        ) END,
        'topLevelReason', a.top_level_reason
      )
      FROM public.employee_assignments a
      JOIN public.branches b ON b.tenant_id=a.tenant_id AND b.id=a.branch_id
      JOIN public.departments d ON d.tenant_id=a.tenant_id AND d.id=a.department_id
      JOIN public.designations g ON g.tenant_id=a.tenant_id AND g.id=a.designation_id
      LEFT JOIN public.employees manager ON manager.tenant_id=a.tenant_id AND manager.id=a.manager_employee_id
      WHERE a.tenant_id=e.tenant_id AND a.employee_id=e.id
        AND a.effective_from <= CURRENT_DATE
        AND (a.effective_to IS NULL OR a.effective_to >= CURRENT_DATE)
      ORDER BY a.effective_from DESC LIMIT 1
    ),
    'assignmentHistory', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', a.id,
        'effectiveFrom', to_char(a.effective_from, 'YYYY-MM-DD'),
        'effectiveTo', CASE WHEN a.effective_to IS NULL THEN NULL ELSE to_char(a.effective_to, 'YYYY-MM-DD') END,
        'branch', jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name),
        'department', jsonb_build_object('id', d.id, 'code', d.code, 'name', d.name),
        'designation', jsonb_build_object('id', g.id, 'code', g.code, 'name', g.name),
        'manager', CASE WHEN manager.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', manager.id, 'employeeNumber', manager.employee_number, 'name', manager.name
        ) END,
        'topLevelReason', a.top_level_reason
      ) ORDER BY a.effective_from DESC)
      FROM public.employee_assignments a
      JOIN public.branches b ON b.tenant_id=a.tenant_id AND b.id=a.branch_id
      JOIN public.departments d ON d.tenant_id=a.tenant_id AND d.id=a.department_id
      JOIN public.designations g ON g.tenant_id=a.tenant_id AND g.id=a.designation_id
      LEFT JOIN public.employees manager ON manager.tenant_id=a.tenant_id AND manager.id=a.manager_employee_id
      WHERE a.tenant_id=e.tenant_id AND a.employee_id=e.id
    ), '[]'::jsonb)
  )
  FROM public.employees e
  LEFT JOIN LATERAL (
    SELECT period.final_working_date FROM public.employment_periods period
      WHERE period.tenant_id=e.tenant_id AND period.employee_id=e.id
      ORDER BY period.period_number DESC LIMIT 1
  ) ep ON true
  WHERE e.tenant_id=p_tenant AND e.id=p_employee
    AND e.joining_date IS NOT NULL AND e.employment_type IS NOT NULL
$$;


COMMIT;
