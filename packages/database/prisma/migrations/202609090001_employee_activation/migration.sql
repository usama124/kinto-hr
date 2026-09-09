BEGIN;

CREATE FUNCTION public.activate_tenant_employee(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid,
  p_expected_version integer, p_reason varchar, p_audit uuid, p_outbox uuid
) RETURNS TABLE(outcome varchar, employee_id uuid, employee_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  current_employee public.employees%ROWTYPE;
  current_period public.employment_periods%ROWTYPE;
  current_assignment public.employee_assignments%ROWTYPE;
  entitlement jsonb;
  employee_limit integer;
  active_employees integer;
  next_version integer;
BEGIN
  IF NOT public.tenant_people_authorized(p_actor, p_mfa_verified, p_tenant, true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_expected_version < 1 OR p_reason IS NULL OR
     length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;

  -- Use the same tenant lock as the original capacity primitive so every
  -- supported activation path serializes the final-seat decision.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text, 0));

  SELECT e.* INTO current_employee FROM public.employees e
    WHERE e.tenant_id = p_tenant AND e.id = p_employee FOR UPDATE;
  IF NOT FOUND OR current_employee.joining_date IS NULL THEN
    RETURN QUERY SELECT 'not_found'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF current_employee.version <> p_expected_version THEN
    RETURN QUERY SELECT 'stale'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF current_employee.status <> 'draft' OR
     current_employee.employment_type <> 'monthly_salaried' OR
     length(btrim(current_employee.employee_number)) = 0 OR
     length(btrim(current_employee.name)) = 0 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;

  SELECT ep.* INTO current_period FROM public.employment_periods ep
    WHERE ep.tenant_id = p_tenant AND ep.employee_id = p_employee
      AND ep.status = 'planned' AND ep.final_working_date IS NULL
    ORDER BY ep.period_number DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR current_period.joining_date <> current_employee.joining_date THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;

  SELECT ea.* INTO current_assignment FROM public.employee_assignments ea
    WHERE ea.tenant_id = p_tenant AND ea.employee_id = p_employee
      AND ea.employment_period_id = current_period.id
      AND ea.effective_from <= current_employee.joining_date
      AND (ea.effective_to IS NULL OR ea.effective_to >= current_employee.joining_date)
    ORDER BY ea.effective_from DESC LIMIT 1;
  IF NOT FOUND OR
     NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.tenant_id=p_tenant AND b.id=current_assignment.branch_id AND b.status='active') OR
     NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.tenant_id=p_tenant AND d.id=current_assignment.department_id AND d.status='active') OR
     NOT EXISTS (SELECT 1 FROM public.designations d WHERE d.tenant_id=p_tenant AND d.id=current_assignment.designation_id AND d.status='active') OR
     (current_assignment.manager_employee_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.employees manager WHERE manager.tenant_id=p_tenant
         AND manager.id=current_assignment.manager_employee_id AND manager.status='active'
     )) OR
     (current_assignment.manager_employee_id IS NULL AND
       (current_assignment.top_level_reason IS NULL OR length(btrim(current_assignment.top_level_reason)) < 3)) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
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

  next_version := current_employee.version + 1;
  UPDATE public.employees SET status='active', version=next_version, updated_at=now()
    WHERE tenant_id=p_tenant AND id=p_employee;
  UPDATE public.employment_periods SET status='active'
    WHERE tenant_id=p_tenant AND id=current_period.id;
  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit, p_tenant, p_actor, 'employee.activated', p_reason, p_employee);
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox, p_tenant, 'employee.activated.v1', p_employee, next_version);
  RETURN QUERY SELECT 'updated'::varchar, p_employee, next_version;
END $$;

REVOKE ALL ON FUNCTION public.activate_tenant_employee(uuid, boolean, uuid, uuid, integer, varchar, uuid, uuid) FROM PUBLIC;

COMMIT;
