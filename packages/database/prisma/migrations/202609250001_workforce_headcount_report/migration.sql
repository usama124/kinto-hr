BEGIN;

CREATE FUNCTION public.read_tenant_workforce_headcount_report(
  p_actor uuid,
  p_mfa_verified boolean,
  p_tenant uuid,
  p_as_of date,
  p_period_start date,
  p_period_end date
) RETURNS TABLE(outcome varchar, snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT public.tenant_people_authorized(p_actor, p_mfa_verified, p_tenant, false) THEN
    RETURN QUERY SELECT 'forbidden'::varchar, NULL::jsonb;
    RETURN;
  END IF;
  IF p_as_of IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR
     p_period_start > p_period_end OR p_period_end - p_period_start > 365 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar, NULL::jsonb;
    RETURN;
  END IF;

  RETURN QUERY
  WITH employed AS (
    SELECT ep.id AS employment_period_id, ep.employee_id
    FROM public.employment_periods ep
    WHERE ep.tenant_id = p_tenant
      AND ep.status IN ('active', 'ended')
      AND ep.joining_date <= p_as_of
      AND (ep.final_working_date IS NULL OR ep.final_working_date >= p_as_of)
  ), effective_assignments AS (
    SELECT employed.employee_id, assignment.department_id
    FROM employed
    LEFT JOIN LATERAL (
      SELECT a.department_id
      FROM public.employee_assignments a
      WHERE a.tenant_id = p_tenant
        AND a.employee_id = employed.employee_id
        AND a.employment_period_id = employed.employment_period_id
        AND a.effective_from <= p_as_of
        AND (a.effective_to IS NULL OR a.effective_to >= p_as_of)
      ORDER BY a.effective_from DESC, a.created_at DESC, a.id
      LIMIT 1
    ) assignment ON true
  )
  SELECT 'ok'::varchar, jsonb_build_object(
    'asOf', to_char(p_as_of, 'YYYY-MM-DD'),
    'periodStart', to_char(p_period_start, 'YYYY-MM-DD'),
    'periodEnd', to_char(p_period_end, 'YYYY-MM-DD'),
    'headcount', (SELECT count(*)::integer FROM employed),
    'joiners', (
      SELECT count(*)::integer
      FROM public.employment_periods ep
      WHERE ep.tenant_id = p_tenant
        AND ep.status IN ('active', 'ended')
        AND ep.joining_date BETWEEN p_period_start AND p_period_end
    ),
    'leavers', (
      SELECT count(*)::integer
      FROM public.employment_periods ep
      WHERE ep.tenant_id = p_tenant
        AND ep.status IN ('active', 'ended')
        AND ep.final_working_date BETWEEN p_period_start AND p_period_end
    ),
    'departments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'departmentId', d.id,
        'departmentCode', d.code,
        'departmentName', d.name,
        'headcount', grouped.headcount
      ) ORDER BY d.code, d.id)
      FROM (
        SELECT ea.department_id, count(*)::integer AS headcount
        FROM effective_assignments ea
        WHERE ea.department_id IS NOT NULL
        GROUP BY ea.department_id
      ) grouped
      JOIN public.departments d
        ON d.tenant_id = p_tenant AND d.id = grouped.department_id
    ), '[]'::jsonb),
    'unassignedHeadcount', (
      SELECT count(*)::integer
      FROM effective_assignments ea
      WHERE ea.department_id IS NULL
    )
  );
END $$;

REVOKE ALL ON FUNCTION public.read_tenant_workforce_headcount_report(
  uuid, boolean, uuid, date, date, date
) FROM PUBLIC;

COMMIT;
