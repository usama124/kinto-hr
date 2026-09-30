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
    'payrollSetup', CASE WHEN EXISTS (SELECT 1 FROM public.compensation_agreements ca WHERE ca.tenant_id=e.tenant_id AND ca.employee_id=e.id) THEN 'complete' ELSE 'incomplete' END,
    'accountAccess', jsonb_build_object(
      'status', CASE WHEN access.membership_id IS NULL THEN 'not_provisioned'
        WHEN access.membership_status='active' THEN 'active' ELSE 'revoked' END,
      'membershipVersion', access.membership_version
    ),
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
  LEFT JOIN LATERAL (
    SELECT m.id AS membership_id, m.status AS membership_status,
      m.version AS membership_version
    FROM public.employee_identity_links link
    JOIN public.memberships m
      ON m.tenant_id=link.tenant_id AND m.id=link.membership_id
    WHERE link.tenant_id=e.tenant_id AND link.employee_id=e.id
  ) access ON true
  WHERE e.tenant_id=p_tenant AND e.id=p_employee
    AND e.joining_date IS NOT NULL AND e.employment_type IS NOT NULL
$$;

CREATE FUNCTION public.reactivate_tenant_employee_account(
  p_actor uuid, p_mfa_verified boolean, p_tenant uuid, p_employee uuid,
  p_expected_membership_version integer, p_reason varchar,
  p_audit uuid, p_outbox uuid
) RETURNS TABLE(
  outcome varchar, membership_id uuid, membership_version integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  current_employee public.employees%ROWTYPE;
  latest_period public.employment_periods%ROWTYPE;
  linked record;
  next_version integer;
BEGIN
  IF NOT public.tenant_people_authorized(p_actor, p_mfa_verified, p_tenant, true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF p_expected_membership_version < 1 OR p_reason IS NULL OR
     length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;

  SELECT e.* INTO current_employee FROM public.employees e
    WHERE e.tenant_id=p_tenant AND e.id=p_employee FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  SELECT ep.* INTO latest_period FROM public.employment_periods ep
    WHERE ep.tenant_id=p_tenant AND ep.employee_id=p_employee
    ORDER BY ep.period_number DESC LIMIT 1 FOR UPDATE;
  IF current_employee.status<>'active' OR NOT FOUND OR
     latest_period.status<>'active' OR latest_period.period_number<2 OR
     NOT EXISTS (SELECT 1 FROM public.employment_periods previous
       WHERE previous.tenant_id=p_tenant AND previous.employee_id=p_employee
         AND previous.period_number<latest_period.period_number
         AND previous.status='ended') THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;

  SELECT link.id AS link_id, link.membership_id, link.identity_id,
         m.status AS membership_status, m.roles AS membership_roles,
         m.version AS membership_version, i.status AS identity_status,
         invitation.id AS invitation_id, invitation.status AS invitation_status,
         request.id AS request_id, request.status AS request_status
    INTO linked
    FROM public.employee_identity_links link
    JOIN public.memberships m
      ON m.tenant_id=link.tenant_id AND m.id=link.membership_id
    JOIN public.identities i ON i.id=link.identity_id
    JOIN public.employee_invitations invitation
      ON invitation.id=link.invitation_id AND invitation.tenant_id=link.tenant_id
        AND invitation.employee_id=link.employee_id
    JOIN public.employee_account_requests request
      ON request.id=invitation.request_id AND request.tenant_id=link.tenant_id
        AND request.employee_id=link.employee_id
    WHERE link.tenant_id=p_tenant AND link.employee_id=p_employee
    FOR UPDATE OF m, invitation, request;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF linked.membership_version<>p_expected_membership_version THEN
    RETURN QUERY SELECT 'stale'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;
  IF linked.identity_status<>'active' OR linked.membership_status<>'revoked' OR
     linked.membership_roles<>ARRAY['employee']::text[] OR
     linked.invitation_status<>'revoked' OR linked.request_status<>'revoked' THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::uuid, NULL::integer; RETURN;
  END IF;

  next_version := linked.membership_version+1;
  UPDATE public.memberships m SET status='active', version=next_version
    WHERE m.tenant_id=p_tenant AND m.id=linked.membership_id;
  UPDATE public.employee_invitations invitation
    SET status='accepted', version=version+1
    WHERE invitation.id=linked.invitation_id;
  UPDATE public.employee_account_requests request
    SET status='active', version=version+1
    WHERE request.id=linked.request_id;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.account_reactivated',btrim(p_reason),linked.membership_id);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.account_reactivated.v1',p_employee,next_version);
  RETURN QUERY SELECT 'reactivated'::varchar, linked.membership_id, next_version;
END $$;

REVOKE ALL ON FUNCTION public.reactivate_tenant_employee_account(
  uuid, boolean, uuid, uuid, integer, varchar, uuid, uuid
) FROM PUBLIC;

COMMIT;
