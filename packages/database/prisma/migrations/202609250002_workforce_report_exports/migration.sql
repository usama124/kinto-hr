BEGIN;

CREATE TABLE public.workforce_report_exports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  kind varchar(40) NOT NULL CHECK (kind = 'workforce_headcount_csv'),
  parameters jsonb NOT NULL,
  snapshot jsonb,
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','expired')),
  created_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  reason varchar(240) NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ready_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,request_key),
  CHECK (expires_at > created_at),
  CHECK (
    (status='pending' AND snapshot IS NULL AND ready_at IS NULL) OR
    (status='ready' AND snapshot IS NOT NULL AND ready_at IS NOT NULL) OR
    (status='expired')
  )
);
CREATE INDEX workforce_report_exports_tenant_created_idx
  ON public.workforce_report_exports(tenant_id,created_at DESC);
CREATE INDEX workforce_report_exports_tenant_status_expiry_idx
  ON public.workforce_report_exports(tenant_id,status,expires_at);
ALTER TABLE public.workforce_report_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workforce_report_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.workforce_report_exports
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION public.workforce_headcount_report_json(
  p_tenant uuid,p_as_of date,p_period_start date,p_period_end date
) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  WITH employed AS (
    SELECT ep.id AS employment_period_id,ep.employee_id
    FROM public.employment_periods ep
    WHERE ep.tenant_id=p_tenant AND ep.status IN ('active','ended')
      AND ep.joining_date<=p_as_of
      AND (ep.final_working_date IS NULL OR ep.final_working_date>=p_as_of)
  ), effective_assignments AS (
    SELECT employed.employee_id,assignment.department_id
    FROM employed
    LEFT JOIN LATERAL (
      SELECT a.department_id FROM public.employee_assignments a
      WHERE a.tenant_id=p_tenant AND a.employee_id=employed.employee_id
        AND a.employment_period_id=employed.employment_period_id
        AND a.effective_from<=p_as_of
        AND (a.effective_to IS NULL OR a.effective_to>=p_as_of)
      ORDER BY a.effective_from DESC,a.created_at DESC,a.id LIMIT 1
    ) assignment ON true
  )
  SELECT jsonb_build_object(
    'asOf',to_char(p_as_of,'YYYY-MM-DD'),
    'periodStart',to_char(p_period_start,'YYYY-MM-DD'),
    'periodEnd',to_char(p_period_end,'YYYY-MM-DD'),
    'headcount',(SELECT count(*)::integer FROM employed),
    'joiners',(SELECT count(*)::integer FROM public.employment_periods ep
      WHERE ep.tenant_id=p_tenant AND ep.status IN ('active','ended')
        AND ep.joining_date BETWEEN p_period_start AND p_period_end),
    'leavers',(SELECT count(*)::integer FROM public.employment_periods ep
      WHERE ep.tenant_id=p_tenant AND ep.status IN ('active','ended')
        AND ep.final_working_date BETWEEN p_period_start AND p_period_end),
    'departments',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'departmentId',d.id,'departmentCode',d.code,'departmentName',d.name,
      'headcount',grouped.headcount) ORDER BY d.code,d.id)
      FROM (SELECT ea.department_id,count(*)::integer AS headcount
        FROM effective_assignments ea WHERE ea.department_id IS NOT NULL
        GROUP BY ea.department_id) grouped
      JOIN public.departments d ON d.tenant_id=p_tenant AND d.id=grouped.department_id
    ),'[]'::jsonb),
    'unassignedHeadcount',(SELECT count(*)::integer FROM effective_assignments ea
      WHERE ea.department_id IS NULL)
  )
$$;

CREATE OR REPLACE FUNCTION public.read_tenant_workforce_headcount_report(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_as_of date,
  p_period_start date,p_period_end date
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT public.tenant_people_authorized(p_actor,p_mfa_verified,p_tenant,false) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_as_of IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR
    p_period_start>p_period_end OR p_period_end-p_period_start>365 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::varchar,public.workforce_headcount_report_json(
    p_tenant,p_as_of,p_period_start,p_period_end);
END $$;

CREATE FUNCTION public.workforce_report_export_json(
  p_export public.workforce_report_exports
) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'id',p_export.id,'kind',p_export.kind,
    'status',CASE WHEN p_export.expires_at<=now() THEN 'expired' ELSE p_export.status END,
    'parameters',p_export.parameters,
    'createdAt',to_char(p_export.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt',to_char(p_export.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )
$$;

CREATE FUNCTION public.create_tenant_workforce_report_export(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_export uuid,p_request_key uuid,
  p_request_digest varchar,p_kind varchar,p_as_of date,p_period_start date,p_period_end date,
  p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE existing public.workforce_report_exports%ROWTYPE;
  created public.workforce_report_exports%ROWTYPE;
BEGIN
  IF NOT public.tenant_people_authorized(p_actor,p_mfa_verified,p_tenant,true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_request_digest !~ '^[a-f0-9]{64}$' OR p_kind<>'workforce_headcount_csv'
    OR p_as_of IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR p_period_start>p_period_end OR p_period_end-p_period_start>365
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||p_request_key::text,73));
  SELECT e.* INTO existing FROM public.workforce_report_exports e
    WHERE e.tenant_id=p_tenant AND e.request_key=p_request_key;
  IF FOUND THEN
    IF existing.request_digest<>p_request_digest THEN
      RETURN QUERY SELECT 'conflict'::varchar,NULL::jsonb; RETURN;
    END IF;
    RETURN QUERY SELECT 'replayed'::varchar,public.workforce_report_export_json(existing); RETURN;
  END IF;
  INSERT INTO public.workforce_report_exports(
    id,tenant_id,request_key,request_digest,kind,parameters,
    created_by_identity_id,reason,expires_at
  ) VALUES (
    p_export,p_tenant,p_request_key,p_request_digest,p_kind,
    jsonb_build_object('asOf',to_char(p_as_of,'YYYY-MM-DD'),
      'periodStart',to_char(p_period_start,'YYYY-MM-DD'),
      'periodEnd',to_char(p_period_end,'YYYY-MM-DD')),
    p_actor,btrim(p_reason),now()+interval '24 hours'
  ) RETURNING * INTO created;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'workforce_report_export.created',btrim(p_reason),p_export);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'workforce_report_export.requested.v1',p_export,1);
  RETURN QUERY SELECT 'created'::varchar,public.workforce_report_export_json(created);
END $$;

CREATE FUNCTION public.generate_tenant_workforce_report_export(
  p_tenant uuid,p_export uuid
) RETURNS TABLE(outcome varchar)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_export public.workforce_report_exports%ROWTYPE;
BEGIN
  IF nullif(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM p_tenant THEN
    RETURN QUERY SELECT 'forbidden'::varchar; RETURN;
  END IF;
  SELECT e.* INTO current_export FROM public.workforce_report_exports e
    WHERE e.tenant_id=p_tenant AND e.id=p_export FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar; RETURN; END IF;
  IF current_export.status='ready' THEN RETURN QUERY SELECT 'ready'::varchar; RETURN; END IF;
  IF current_export.status='expired' OR current_export.expires_at<=now() THEN
    UPDATE public.workforce_report_exports SET status='expired'
      WHERE tenant_id=p_tenant AND id=p_export;
    RETURN QUERY SELECT 'expired'::varchar; RETURN;
  END IF;
  UPDATE public.workforce_report_exports SET
    snapshot=public.workforce_headcount_report_json(
      p_tenant,(current_export.parameters->>'asOf')::date,
      (current_export.parameters->>'periodStart')::date,
      (current_export.parameters->>'periodEnd')::date),
    status='ready',ready_at=now()
    WHERE tenant_id=p_tenant AND id=p_export;
  RETURN QUERY SELECT 'ready'::varchar;
END $$;

CREATE FUNCTION public.read_tenant_workforce_report_export(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_export uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected public.workforce_report_exports%ROWTYPE;
BEGIN
  IF NOT public.tenant_people_authorized(p_actor,p_mfa_verified,p_tenant,false) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT e.* INTO selected FROM public.workforce_report_exports e
    WHERE e.tenant_id=p_tenant AND e.id=p_export;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::varchar,public.workforce_report_export_json(selected);
END $$;

CREATE FUNCTION public.authorize_tenant_workforce_report_export_download(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_export uuid,p_audit uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected public.workforce_report_exports%ROWTYPE;
BEGIN
  IF NOT public.tenant_people_authorized(p_actor,p_mfa_verified,p_tenant,false) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT e.* INTO selected FROM public.workforce_report_exports e
    WHERE e.tenant_id=p_tenant AND e.id=p_export FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  IF selected.expires_at<=now() THEN
    UPDATE public.workforce_report_exports SET status='expired'
      WHERE tenant_id=p_tenant AND id=p_export AND status<>'expired';
    RETURN QUERY SELECT 'expired'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF selected.status<>'ready' OR selected.snapshot IS NULL THEN
    RETURN QUERY SELECT 'pending'::varchar,NULL::jsonb; RETURN;
  END IF;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'workforce_report_export.downloaded',
      'Authorized workforce report CSV download',p_export);
  RETURN QUERY SELECT 'ok'::varchar,jsonb_build_object(
    'export',public.workforce_report_export_json(selected),'report',selected.snapshot);
END $$;

REVOKE ALL ON FUNCTION public.workforce_headcount_report_json(uuid,date,date,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workforce_report_export_json(public.workforce_report_exports) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_tenant_workforce_report_export(uuid,boolean,uuid,uuid,uuid,varchar,varchar,date,date,date,varchar,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_tenant_workforce_report_export(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_tenant_workforce_report_export(uuid,boolean,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_tenant_workforce_report_export_download(uuid,boolean,uuid,uuid,uuid) FROM PUBLIC;

COMMIT;
