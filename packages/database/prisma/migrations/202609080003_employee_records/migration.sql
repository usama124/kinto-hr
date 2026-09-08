BEGIN;

ALTER TABLE public.employees
  ADD COLUMN legal_name varchar(160),
  ADD COLUMN joining_date date,
  ADD COLUMN employment_type varchar(30),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.employees
  ADD CONSTRAINT employees_employment_type_check
  CHECK (employment_type IS NULL OR employment_type = 'monthly_salaried');

CREATE TABLE public.employment_periods (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  period_number integer NOT NULL CHECK (period_number > 0),
  joining_date date NOT NULL,
  final_working_date date,
  status varchar(20) NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'ended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (final_working_date IS NULL OR final_working_date >= joining_date),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, id, employee_id),
  UNIQUE (tenant_id, employee_id, period_number),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES public.employees(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX employment_periods_tenant_employee_status_idx
  ON public.employment_periods(tenant_id, employee_id, status);

CREATE TABLE public.employee_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  employment_period_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  department_id uuid NOT NULL,
  designation_id uuid NOT NULL,
  manager_employee_id uuid,
  top_level_reason varchar(240),
  effective_from date NOT NULL,
  effective_to date,
  created_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (
    (manager_employee_id IS NOT NULL AND top_level_reason IS NULL) OR
    (manager_employee_id IS NULL AND length(btrim(top_level_reason)) >= 3)
  ),
  CHECK (manager_employee_id IS NULL OR manager_employee_id <> employee_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES public.employees(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, employment_period_id, employee_id) REFERENCES public.employment_periods(tenant_id, id, employee_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, department_id) REFERENCES public.departments(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, designation_id) REFERENCES public.designations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, manager_employee_id) REFERENCES public.employees(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX employee_assignments_tenant_employee_effective_idx
  ON public.employee_assignments(tenant_id, employee_id, effective_from);
CREATE INDEX employee_assignments_tenant_manager_effective_idx
  ON public.employee_assignments(tenant_id, manager_employee_id, effective_from);

ALTER TABLE public.employment_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employment_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.employment_periods
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE public.employee_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.employee_assignments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION public.tenant_people_authorized(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_write boolean
) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT p_mfa_verified AND EXISTS (
    SELECT 1 FROM public.tenants t
    JOIN public.memberships m ON m.tenant_id = t.id
    JOIN public.identities i ON i.id = m.identity_id
    WHERE t.id = p_tenant AND t.status = 'active' AND i.id = p_actor
      AND i.status = 'active' AND m.status = 'active'
      AND m.roles && ARRAY['owner', 'hr_admin']::text[]
      AND (NOT p_write OR m.roles && ARRAY['owner', 'hr_admin']::text[])
  )
$$;
REVOKE ALL ON FUNCTION public.tenant_people_authorized(uuid, boolean, uuid, boolean) FROM PUBLIC;

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
    'payrollSetup', 'incomplete',
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
      JOIN public.branches b ON b.tenant_id = a.tenant_id AND b.id = a.branch_id
      JOIN public.departments d ON d.tenant_id = a.tenant_id AND d.id = a.department_id
      JOIN public.designations g ON g.tenant_id = a.tenant_id AND g.id = a.designation_id
      LEFT JOIN public.employees manager ON manager.tenant_id = a.tenant_id AND manager.id = a.manager_employee_id
      WHERE a.tenant_id = e.tenant_id AND a.employee_id = e.id
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
      JOIN public.branches b ON b.tenant_id = a.tenant_id AND b.id = a.branch_id
      JOIN public.departments d ON d.tenant_id = a.tenant_id AND d.id = a.department_id
      JOIN public.designations g ON g.tenant_id = a.tenant_id AND g.id = a.designation_id
      LEFT JOIN public.employees manager ON manager.tenant_id = a.tenant_id AND manager.id = a.manager_employee_id
      WHERE a.tenant_id = e.tenant_id AND a.employee_id = e.id
    ), '[]'::jsonb)
  )
  FROM public.employees e
  WHERE e.tenant_id = p_tenant AND e.id = p_employee
    AND e.joining_date IS NOT NULL AND e.employment_type IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.employee_record_json(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.read_tenant_employees(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid DEFAULT NULL
) RETURNS TABLE(outcome varchar, snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.tenant_people_authorized(p_actor, p_mfa_verified, p_tenant, false) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::jsonb; RETURN;
  END IF;
  IF p_employee IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.employees e WHERE e.tenant_id = p_tenant AND e.id = p_employee
      AND e.joining_date IS NOT NULL AND e.employment_type IS NOT NULL
  ) THEN
    RETURN QUERY SELECT 'not_found'::varchar, NULL::jsonb; RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::varchar,
    CASE WHEN p_employee IS NULL THEN jsonb_build_object(
      'employees', COALESCE((SELECT jsonb_agg(public.employee_record_json(p_tenant, e.id)
        ORDER BY e.employee_number) FROM public.employees e WHERE e.tenant_id = p_tenant
        AND e.joining_date IS NOT NULL AND e.employment_type IS NOT NULL), '[]'::jsonb)
    ) ELSE public.employee_record_json(p_tenant, p_employee) END;
END $$;

CREATE OR REPLACE FUNCTION public.create_tenant_employee(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid,
  p_employee uuid, p_period uuid, p_assignment uuid,
  p_employee_number varchar, p_name varchar, p_legal_name varchar,
  p_joining_date date, p_employment_type varchar,
  p_branch uuid, p_department uuid, p_designation uuid,
  p_manager uuid, p_top_level_reason varchar, p_reason varchar,
  p_audit uuid, p_outbox uuid
) RETURNS TABLE(outcome varchar, employee_id uuid, employee_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.tenant_people_authorized(p_actor, p_mfa_verified, p_tenant, true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 41));
  IF p_employment_type <> 'monthly_salaried' OR
     EXISTS (SELECT 1 FROM public.employees WHERE tenant_id = p_tenant AND employee_number = p_employee_number) THEN
    RETURN QUERY SELECT 'conflict'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE tenant_id=p_tenant AND id=p_branch AND status='active') OR
     NOT EXISTS (SELECT 1 FROM public.departments WHERE tenant_id=p_tenant AND id=p_department AND status='active') OR
     NOT EXISTS (SELECT 1 FROM public.designations WHERE tenant_id=p_tenant AND id=p_designation AND status='active') OR
     (p_manager IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.employees WHERE tenant_id=p_tenant AND id=p_manager AND status IN ('draft','active'))) OR
     (p_manager IS NULL AND (p_top_level_reason IS NULL OR length(btrim(p_top_level_reason)) < 3)) OR
     (p_manager IS NOT NULL AND p_top_level_reason IS NOT NULL) OR p_manager = p_employee THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  INSERT INTO public.employees(id, tenant_id, employee_number, name, legal_name, joining_date, employment_type)
    VALUES (p_employee, p_tenant, p_employee_number, p_name, p_legal_name, p_joining_date, p_employment_type);
  INSERT INTO public.employment_periods(id, tenant_id, employee_id, period_number, joining_date)
    VALUES (p_period, p_tenant, p_employee, 1, p_joining_date);
  INSERT INTO public.employee_assignments(id, tenant_id, employee_id, employment_period_id,
    branch_id, department_id, designation_id, manager_employee_id, top_level_reason,
    effective_from, created_by_identity_id)
    VALUES (p_assignment, p_tenant, p_employee, p_period, p_branch, p_department, p_designation,
      p_manager, p_top_level_reason, p_joining_date, p_actor);
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit, p_tenant, p_actor, 'employee.draft_created', p_reason, p_employee);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox, p_tenant, 'employee.draft_created.v1', p_employee, 1);
  RETURN QUERY SELECT 'created'::varchar, p_employee, 1;
END $$;

CREATE OR REPLACE FUNCTION public.update_tenant_employee_profile(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid,
  p_expected_version integer, p_name varchar, p_legal_name varchar, p_reason varchar,
  p_audit uuid, p_outbox uuid
) RETURNS TABLE(outcome varchar, employee_id uuid, employee_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_employee public.employees%ROWTYPE; next_version integer;
BEGIN
  IF NOT public.tenant_people_authorized(p_actor, p_mfa_verified, p_tenant, true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT * INTO current_employee FROM public.employees
    WHERE tenant_id=p_tenant AND id=p_employee AND joining_date IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar, NULL::uuid, NULL::integer; RETURN; END IF;
  IF current_employee.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF current_employee.status IN ('terminated','archived') OR
     (current_employee.name = p_name AND current_employee.legal_name IS NOT DISTINCT FROM p_legal_name) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  next_version := current_employee.version + 1;
  UPDATE public.employees SET name=p_name, legal_name=p_legal_name, version=next_version, updated_at=now()
    WHERE tenant_id=p_tenant AND id=p_employee;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit, p_tenant, p_actor, 'employee.profile_updated', p_reason, p_employee);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox, p_tenant, 'employee.profile_updated.v1', p_employee, next_version);
  RETURN QUERY SELECT 'updated'::varchar, p_employee, next_version;
END $$;

CREATE OR REPLACE FUNCTION public.create_tenant_employee_assignment(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid,
  p_assignment uuid, p_expected_version integer, p_effective_from date,
  p_branch uuid, p_department uuid, p_designation uuid,
  p_manager uuid, p_top_level_reason varchar, p_reason varchar,
  p_audit uuid, p_outbox uuid
) RETURNS TABLE(outcome varchar, employee_id uuid, employee_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_employee public.employees%ROWTYPE; previous_assignment public.employee_assignments%ROWTYPE;
  period_id uuid; next_version integer; cycle_found boolean;
BEGIN
  IF NOT public.tenant_people_authorized(p_actor, p_mfa_verified, p_tenant, true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT * INTO current_employee FROM public.employees
    WHERE tenant_id=p_tenant AND id=p_employee AND joining_date IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar, NULL::uuid, NULL::integer; RETURN; END IF;
  IF current_employee.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT ep.id INTO period_id FROM public.employment_periods ep
    WHERE ep.tenant_id=p_tenant AND ep.employee_id=p_employee AND ep.status IN ('planned','active')
    ORDER BY ep.period_number DESC LIMIT 1;
  SELECT ea.* INTO previous_assignment FROM public.employee_assignments ea
    WHERE ea.tenant_id=p_tenant AND ea.employee_id=p_employee ORDER BY ea.effective_from DESC LIMIT 1 FOR UPDATE;
  IF current_employee.status NOT IN ('draft','active') OR period_id IS NULL OR
     p_effective_from < CURRENT_DATE OR p_effective_from <= previous_assignment.effective_from OR
     NOT EXISTS (SELECT 1 FROM public.branches WHERE tenant_id=p_tenant AND id=p_branch AND status='active') OR
     NOT EXISTS (SELECT 1 FROM public.departments WHERE tenant_id=p_tenant AND id=p_department AND status='active') OR
     NOT EXISTS (SELECT 1 FROM public.designations WHERE tenant_id=p_tenant AND id=p_designation AND status='active') OR
     (p_manager IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.employees WHERE tenant_id=p_tenant AND id=p_manager AND status IN ('draft','active'))) OR
     (p_manager IS NULL AND (p_top_level_reason IS NULL OR length(btrim(p_top_level_reason)) < 3)) OR
     (p_manager IS NOT NULL AND p_top_level_reason IS NOT NULL) OR p_manager = p_employee OR
     (previous_assignment.branch_id=p_branch AND previous_assignment.department_id=p_department AND
      previous_assignment.designation_id=p_designation AND previous_assignment.manager_employee_id IS NOT DISTINCT FROM p_manager AND
      previous_assignment.top_level_reason IS NOT DISTINCT FROM p_top_level_reason) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_manager IS NOT NULL THEN
    WITH RECURSIVE reporting_chain(chain_employee_id) AS (
      SELECT p_manager
      UNION
      SELECT a.manager_employee_id FROM reporting_chain chain
      JOIN LATERAL (
        SELECT ea.manager_employee_id FROM public.employee_assignments ea
        WHERE ea.tenant_id=p_tenant AND ea.employee_id=chain.chain_employee_id
          AND ea.effective_from <= p_effective_from
          AND (ea.effective_to IS NULL OR ea.effective_to >= p_effective_from)
        ORDER BY ea.effective_from DESC LIMIT 1
      ) a ON true WHERE a.manager_employee_id IS NOT NULL
    ) SELECT EXISTS (SELECT 1 FROM reporting_chain rc WHERE rc.chain_employee_id=p_employee) INTO cycle_found;
    IF cycle_found THEN RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN; END IF;
  END IF;
  UPDATE public.employee_assignments SET effective_to=p_effective_from - 1
    WHERE tenant_id=p_tenant AND id=previous_assignment.id;
  INSERT INTO public.employee_assignments(id, tenant_id, employee_id, employment_period_id,
    branch_id, department_id, designation_id, manager_employee_id, top_level_reason,
    effective_from, created_by_identity_id)
    VALUES (p_assignment, p_tenant, p_employee, period_id, p_branch, p_department, p_designation,
      p_manager, p_top_level_reason, p_effective_from, p_actor);
  next_version := current_employee.version + 1;
  UPDATE public.employees SET version=next_version, updated_at=now() WHERE tenant_id=p_tenant AND id=p_employee;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit, p_tenant, p_actor, 'employee.assignment_changed', p_reason, p_employee);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox, p_tenant, 'employee.assignment_changed.v1', p_employee, next_version);
  RETURN QUERY SELECT 'created'::varchar, p_employee, next_version;
END $$;

REVOKE ALL ON FUNCTION public.read_tenant_employees(uuid, boolean, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_tenant_employee(uuid, boolean, uuid, uuid, uuid, uuid, varchar, varchar, varchar, date, varchar, uuid, uuid, uuid, uuid, varchar, varchar, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_tenant_employee_profile(uuid, boolean, uuid, uuid, integer, varchar, varchar, varchar, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_tenant_employee_assignment(uuid, boolean, uuid, uuid, uuid, integer, date, uuid, uuid, uuid, uuid, varchar, varchar, uuid, uuid) FROM PUBLIC;

COMMIT;
