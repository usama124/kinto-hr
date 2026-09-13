BEGIN;

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

CREATE FUNCTION public.rehire_tenant_employee(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid,
  p_period uuid, p_assignment uuid, p_expected_version integer,
  p_joining_date date, p_branch uuid, p_department uuid, p_designation uuid,
  p_manager uuid, p_top_level_reason varchar, p_reason varchar,
  p_audit uuid, p_outbox uuid
) RETURNS TABLE(outcome varchar, employee_id uuid, employee_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  current_employee public.employees%ROWTYPE;
  latest_period public.employment_periods%ROWTYPE;
  entitlement jsonb;
  employee_limit integer;
  active_employees integer;
  local_today date;
  next_version integer;
  cycle_found boolean;
BEGIN
  IF NOT public.tenant_people_authorized(p_actor, p_mfa_verified, p_tenant, true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_expected_version < 1 OR p_joining_date IS NULL OR p_reason IS NULL OR
     length(btrim(p_reason)) NOT BETWEEN 3 AND 240 OR
     (p_manager IS NULL AND (p_top_level_reason IS NULL OR length(btrim(p_top_level_reason)) NOT BETWEEN 3 AND 240)) OR
     (p_manager IS NOT NULL AND p_top_level_reason IS NOT NULL) OR p_manager=p_employee THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 0));
  SELECT (now() AT TIME ZONE le.time_zone)::date INTO local_today
    FROM public.legal_entities le WHERE le.tenant_id=p_tenant;
  IF local_today IS NULL THEN
    RETURN QUERY SELECT 'tenant_unavailable'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT e.* INTO current_employee FROM public.employees e
    WHERE e.tenant_id=p_tenant AND e.id=p_employee FOR UPDATE;
  IF NOT FOUND OR current_employee.joining_date IS NULL THEN
    RETURN QUERY SELECT 'not_found'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF current_employee.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT ep.* INTO latest_period FROM public.employment_periods ep
    WHERE ep.tenant_id=p_tenant AND ep.employee_id=p_employee
    ORDER BY ep.period_number DESC LIMIT 1 FOR UPDATE;
  IF current_employee.status <> 'archived' OR current_employee.employment_type <> 'monthly_salaried' OR
     NOT FOUND OR latest_period.status <> 'ended' OR latest_period.final_working_date IS NULL OR
     p_joining_date < local_today OR p_joining_date <= latest_period.final_working_date OR
     EXISTS (SELECT 1 FROM public.employment_periods ep WHERE ep.tenant_id=p_tenant
       AND ep.employee_id=p_employee AND ep.status IN ('planned','active')) OR
     NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.tenant_id=p_tenant AND b.id=p_branch AND b.status='active') OR
     NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.tenant_id=p_tenant AND d.id=p_department AND d.status='active') OR
     NOT EXISTS (SELECT 1 FROM public.designations d WHERE d.tenant_id=p_tenant AND d.id=p_designation AND d.status='active') OR
     (p_manager IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.employees manager
       WHERE manager.tenant_id=p_tenant AND manager.id=p_manager AND manager.status='active')) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_manager IS NOT NULL THEN
    WITH RECURSIVE reporting_chain(chain_employee_id) AS (
      SELECT p_manager UNION
      SELECT a.manager_employee_id FROM reporting_chain chain JOIN LATERAL (
        SELECT ea.manager_employee_id FROM public.employee_assignments ea
        WHERE ea.tenant_id=p_tenant AND ea.employee_id=chain.chain_employee_id
          AND ea.effective_from <= p_joining_date
          AND (ea.effective_to IS NULL OR ea.effective_to >= p_joining_date)
        ORDER BY ea.effective_from DESC LIMIT 1
      ) a ON true WHERE a.manager_employee_id IS NOT NULL
    ) SELECT EXISTS (SELECT 1 FROM reporting_chain rc WHERE rc.chain_employee_id=p_employee) INTO cycle_found;
    IF cycle_found THEN
      RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
    END IF;
  END IF;

  entitlement := public.resolve_tenant_entitlements_at(p_tenant, now(), NULL, NULL, NULL);
  IF entitlement IS NULL THEN
    RETURN QUERY SELECT 'tenant_unavailable'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  employee_limit := (entitlement->>'employeeLimit')::integer;
  SELECT count(*)::integer INTO active_employees FROM public.employees e
    WHERE e.tenant_id=p_tenant AND e.status='active';
  IF active_employees >= employee_limit THEN
    RETURN QUERY SELECT 'capacity_reached'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;

  INSERT INTO public.employment_periods(id, tenant_id, employee_id, period_number, joining_date, status)
    VALUES (p_period, p_tenant, p_employee, latest_period.period_number+1, p_joining_date, 'active');
  INSERT INTO public.employee_assignments(id, tenant_id, employee_id, employment_period_id,
    branch_id, department_id, designation_id, manager_employee_id, top_level_reason,
    effective_from, created_by_identity_id)
    VALUES (p_assignment, p_tenant, p_employee, p_period, p_branch, p_department, p_designation,
      p_manager, p_top_level_reason, p_joining_date, p_actor);
  next_version := current_employee.version+1;
  UPDATE public.employees e SET status='active', version=next_version, updated_at=now()
    WHERE e.tenant_id=p_tenant AND e.id=p_employee;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit, p_tenant, p_actor, 'employee.rehired', btrim(p_reason), p_employee);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox, p_tenant, 'employee.rehired.v1', p_employee, next_version);
  RETURN QUERY SELECT 'updated'::varchar, p_employee, next_version;
END $$;

REVOKE ALL ON FUNCTION public.rehire_tenant_employee(uuid, boolean, uuid, uuid, uuid, uuid, integer, date, uuid, uuid, uuid, uuid, varchar, varchar, uuid, uuid) FROM PUBLIC;

COMMIT;
