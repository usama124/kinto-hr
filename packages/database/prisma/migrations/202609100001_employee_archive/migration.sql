BEGIN;

ALTER TABLE public.employees
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by_identity_id uuid REFERENCES public.identities(id) ON DELETE RESTRICT,
  ADD COLUMN archive_reason varchar(240),
  ADD CONSTRAINT employees_archive_metadata_check CHECK (
    (archived_at IS NULL AND archived_by_identity_id IS NULL AND archive_reason IS NULL)
    OR
    (archived_at IS NOT NULL AND archived_by_identity_id IS NOT NULL
      AND length(btrim(archive_reason)) BETWEEN 3 AND 240)
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
    'archivedAt', e.archived_at,
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

CREATE FUNCTION public.archive_tenant_employee(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid,
  p_expected_version integer, p_reason varchar, p_audit uuid, p_outbox uuid
) RETURNS TABLE(outcome varchar, employee_id uuid, employee_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  current_employee public.employees%ROWTYPE;
  latest_period public.employment_periods%ROWTYPE;
  next_version integer;
  revoked_membership uuid;
BEGIN
  IF NOT public.tenant_people_authorized(p_actor, p_mfa_verified, p_tenant, true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_expected_version < 1 OR p_reason IS NULL OR
     length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
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
  IF current_employee.status <> 'terminated' OR NOT FOUND OR
     latest_period.status <> 'ended' OR latest_period.final_working_date IS NULL OR
     EXISTS (SELECT 1 FROM public.employment_periods ep
       WHERE ep.tenant_id=p_tenant AND ep.employee_id=p_employee
         AND ep.status IN ('planned','active')) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;

  next_version := current_employee.version + 1;
  UPDATE public.employees e SET status='archived', version=next_version,
      archived_at=now(), archived_by_identity_id=p_actor,
      archive_reason=btrim(p_reason), updated_at=now()
    WHERE e.tenant_id=p_tenant AND e.id=p_employee;

  revoked_membership := NULL;
  UPDATE public.memberships m SET status='revoked', version=m.version+1
    FROM public.employee_identity_links link
    WHERE link.tenant_id=p_tenant AND link.employee_id=p_employee
      AND m.tenant_id=link.tenant_id AND m.id=link.membership_id AND m.status='active'
    RETURNING m.id INTO revoked_membership;
  UPDATE public.employee_invitations ei SET status='revoked', version=ei.version+1
    WHERE ei.tenant_id=p_tenant AND ei.employee_id=p_employee AND ei.status<>'revoked';
  UPDATE public.employee_account_requests ar SET status='revoked', version=ar.version+1
    WHERE ar.tenant_id=p_tenant AND ar.employee_id=p_employee AND ar.status<>'revoked';

  INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
    VALUES (p_audit, p_tenant, p_actor, 'employee.archived', btrim(p_reason), p_employee);
  IF revoked_membership IS NOT NULL THEN
    INSERT INTO public.audit_events(id, tenant_id, actor_id, action, reason, resource_id)
      VALUES (gen_random_uuid(), p_tenant, p_actor, 'employee.access_revoked', btrim(p_reason), revoked_membership);
  END IF;
  INSERT INTO public.outbox_events(id, tenant_id, type, aggregate_id, aggregate_version)
    VALUES (p_outbox, p_tenant, 'employee.archived.v1', p_employee, next_version);
  RETURN QUERY SELECT 'updated'::varchar, p_employee, next_version;
END $$;

REVOKE ALL ON FUNCTION public.archive_tenant_employee(uuid, boolean, uuid, uuid, integer, varchar, uuid, uuid) FROM PUBLIC;

COMMIT;
