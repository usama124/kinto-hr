BEGIN;

ALTER TABLE public.employment_periods
  ADD COLUMN termination_scheduled_by_identity_id uuid REFERENCES public.identities(id) ON DELETE RESTRICT,
  ADD COLUMN termination_reason varchar(240),
  ADD COLUMN termination_scheduled_at timestamptz,
  ADD CONSTRAINT employment_periods_termination_schedule_check CHECK (
    (final_working_date IS NULL AND termination_scheduled_by_identity_id IS NULL
      AND termination_reason IS NULL AND termination_scheduled_at IS NULL)
    OR
    (final_working_date IS NOT NULL AND termination_scheduled_by_identity_id IS NOT NULL
      AND length(btrim(termination_reason)) BETWEEN 3 AND 240
      AND termination_scheduled_at IS NOT NULL)
  );

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
  LEFT JOIN LATERAL (
    SELECT period.final_working_date FROM public.employment_periods period
      WHERE period.tenant_id=e.tenant_id AND period.employee_id=e.id
      ORDER BY period.period_number DESC LIMIT 1
  ) ep ON true
  WHERE e.tenant_id = p_tenant AND e.id = p_employee
    AND e.joining_date IS NOT NULL AND e.employment_type IS NOT NULL
$$;

CREATE FUNCTION public.schedule_tenant_employee_termination(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid,
  p_expected_version integer, p_final_working_date date, p_reason varchar,
  p_audit uuid, p_outbox uuid
) RETURNS TABLE(outcome varchar, employee_id uuid, employee_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  current_employee public.employees%ROWTYPE;
  current_period public.employment_periods%ROWTYPE;
  local_today date;
  next_version integer;
BEGIN
  IF NOT public.tenant_people_authorized(p_actor, p_mfa_verified, p_tenant, true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_expected_version < 1 OR p_final_working_date IS NULL OR p_reason IS NULL OR
     length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT (now() AT TIME ZONE le.time_zone)::date INTO local_today
    FROM public.legal_entities le WHERE le.tenant_id=p_tenant;
  IF local_today IS NULL THEN
    RETURN QUERY SELECT 'tenant_unavailable'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT * INTO current_employee FROM public.employees
    WHERE tenant_id=p_tenant AND id=p_employee FOR UPDATE;
  IF NOT FOUND OR current_employee.joining_date IS NULL THEN
    RETURN QUERY SELECT 'not_found'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF current_employee.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT ep.* INTO current_period FROM public.employment_periods ep
    WHERE ep.tenant_id=p_tenant AND ep.employee_id=p_employee AND ep.status='active'
    ORDER BY ep.period_number DESC LIMIT 1 FOR UPDATE;
  IF current_employee.status <> 'active' OR NOT FOUND OR
     current_period.final_working_date IS NOT NULL OR
     p_final_working_date < local_today OR
     p_final_working_date < current_period.joining_date OR
     EXISTS (
       SELECT 1 FROM public.employee_assignments a
       WHERE a.tenant_id=p_tenant AND a.employee_id=p_employee
         AND a.employment_period_id=current_period.id
         AND a.effective_from > p_final_working_date
     ) OR EXISTS (
       SELECT 1 FROM public.employee_assignments a
       JOIN public.employees report ON report.tenant_id=a.tenant_id AND report.id=a.employee_id
       WHERE a.tenant_id=p_tenant AND a.manager_employee_id=p_employee
         AND report.status='active'
         AND a.effective_from <= p_final_working_date + 1
         AND (a.effective_to IS NULL OR a.effective_to >= p_final_working_date + 1)
     ) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;

  UPDATE public.employee_assignments a
    SET effective_to=p_final_working_date
    WHERE a.tenant_id=p_tenant AND a.employee_id=p_employee
      AND a.employment_period_id=current_period.id
      AND a.effective_from <= p_final_working_date
      AND (a.effective_to IS NULL OR a.effective_to > p_final_working_date);
  UPDATE public.employment_periods ep SET
      final_working_date=p_final_working_date,
      termination_scheduled_by_identity_id=p_actor,
      termination_reason=btrim(p_reason),
      termination_scheduled_at=now()
    WHERE ep.tenant_id=p_tenant AND ep.id=current_period.id;
  next_version := current_employee.version + 1;
  UPDATE public.employees e SET version=next_version, updated_at=now()
    WHERE e.tenant_id=p_tenant AND e.id=p_employee;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit, p_tenant, p_actor, 'employee.termination_scheduled', btrim(p_reason), p_employee);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox, p_tenant, 'employee.termination_scheduled.v1', p_employee, next_version);
  RETURN QUERY SELECT 'updated'::varchar, p_employee, next_version;
END $$;

-- Runs from the restricted dispatcher. Employee access ends at the first poll
-- after the final working date in the employer's configured timezone.
CREATE FUNCTION public.apply_due_employee_terminations(p_batch_size integer)
RETURNS TABLE(processed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  due record;
  applied integer := 0;
  next_version integer;
  revoked_membership uuid;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid termination batch size';
  END IF;
  FOR due IN
    SELECT ep.id AS period_id, ep.tenant_id, ep.employee_id,
      ep.final_working_date, ep.termination_reason,
      ep.termination_scheduled_by_identity_id AS actor_id
    FROM public.employment_periods ep
    JOIN public.employees e ON e.tenant_id=ep.tenant_id AND e.id=ep.employee_id
    JOIN public.legal_entities le ON le.tenant_id=ep.tenant_id
    WHERE ep.status='active' AND e.status='active'
      AND ep.final_working_date IS NOT NULL
      AND (now() AT TIME ZONE le.time_zone)::date > ep.final_working_date
    ORDER BY ep.final_working_date, ep.id
    LIMIT p_batch_size
    FOR UPDATE OF ep, e SKIP LOCKED
  LOOP
    UPDATE public.employees SET status='terminated', version=version+1, updated_at=now()
      WHERE tenant_id=due.tenant_id AND id=due.employee_id AND status='active'
      RETURNING version INTO next_version;
    IF NOT FOUND THEN CONTINUE; END IF;
    UPDATE public.employment_periods SET status='ended'
      WHERE tenant_id=due.tenant_id AND id=due.period_id AND status='active';
    UPDATE public.employee_assignments SET effective_to=due.final_working_date
      WHERE tenant_id=due.tenant_id AND employee_id=due.employee_id
        AND employment_period_id=due.period_id
        AND effective_from <= due.final_working_date
        AND (effective_to IS NULL OR effective_to > due.final_working_date);

    revoked_membership := NULL;
    UPDATE public.memberships m SET status='revoked', version=m.version+1
      FROM public.employee_identity_links link
      WHERE link.tenant_id=due.tenant_id AND link.employee_id=due.employee_id
        AND m.tenant_id=link.tenant_id AND m.id=link.membership_id AND m.status='active'
      RETURNING m.id INTO revoked_membership;
    UPDATE public.employee_invitations SET status='revoked', version=version+1
      WHERE tenant_id=due.tenant_id AND employee_id=due.employee_id AND status<>'revoked';
    UPDATE public.employee_account_requests SET status='revoked', version=version+1
      WHERE tenant_id=due.tenant_id AND employee_id=due.employee_id AND status<>'revoked';

    INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
      VALUES (gen_random_uuid(), due.tenant_id, due.actor_id, 'employee.terminated', due.termination_reason, due.employee_id);
    IF revoked_membership IS NOT NULL THEN
      INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
        VALUES (gen_random_uuid(), due.tenant_id, due.actor_id, 'employee.access_revoked', due.termination_reason, revoked_membership);
    END IF;
    INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
      VALUES (gen_random_uuid(), due.tenant_id, 'employee.terminated.v1', due.employee_id, next_version);
    applied := applied + 1;
  END LOOP;
  RETURN QUERY SELECT applied;
END $$;

-- Keep assignment history within an already approved final working date.
CREATE OR REPLACE FUNCTION public.create_tenant_employee_assignment(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid,
  p_assignment uuid, p_expected_version integer, p_effective_from date,
  p_branch uuid, p_department uuid, p_designation uuid,
  p_manager uuid, p_top_level_reason varchar, p_reason varchar,
  p_audit uuid, p_outbox uuid
) RETURNS TABLE(outcome varchar, employee_id uuid, employee_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_employee public.employees%ROWTYPE; previous_assignment public.employee_assignments%ROWTYPE;
  current_period public.employment_periods%ROWTYPE; next_version integer; cycle_found boolean;
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
  SELECT ep.* INTO current_period FROM public.employment_periods ep
    WHERE ep.tenant_id=p_tenant AND ep.employee_id=p_employee AND ep.status IN ('planned','active')
    ORDER BY ep.period_number DESC LIMIT 1;
  SELECT ea.* INTO previous_assignment FROM public.employee_assignments ea
    WHERE ea.tenant_id=p_tenant AND ea.employee_id=p_employee ORDER BY ea.effective_from DESC LIMIT 1 FOR UPDATE;
  IF current_employee.status NOT IN ('draft','active') OR current_period.id IS NULL OR
     p_effective_from < CURRENT_DATE OR p_effective_from <= previous_assignment.effective_from OR
     (current_period.final_working_date IS NOT NULL AND p_effective_from > current_period.final_working_date) OR
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
      SELECT p_manager UNION
      SELECT a.manager_employee_id FROM reporting_chain chain JOIN LATERAL (
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
    effective_from, effective_to, created_by_identity_id)
    VALUES (p_assignment, p_tenant, p_employee, current_period.id, p_branch, p_department, p_designation,
      p_manager, p_top_level_reason, p_effective_from, current_period.final_working_date, p_actor);
  next_version := current_employee.version + 1;
  UPDATE public.employees SET version=next_version, updated_at=now() WHERE tenant_id=p_tenant AND id=p_employee;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit, p_tenant, p_actor, 'employee.assignment_changed', p_reason, p_employee);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox, p_tenant, 'employee.assignment_changed.v1', p_employee, next_version);
  RETURN QUERY SELECT 'created'::varchar, p_employee, next_version;
END $$;

REVOKE ALL ON FUNCTION public.schedule_tenant_employee_termination(uuid, boolean, uuid, uuid, integer, date, varchar, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_due_employee_terminations(integer) FROM PUBLIC;

COMMIT;
