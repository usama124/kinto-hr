BEGIN;

ALTER TABLE public.employee_profile_change_requests
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN decision_key uuid,
  ADD COLUMN decision_digest char(64) CHECK (decision_digest IS NULL OR decision_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN decided_by_identity_id uuid REFERENCES public.identities(id) ON DELETE RESTRICT,
  ADD COLUMN decision_reason varchar(240),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN applied_contact_version integer CHECK (applied_contact_version IS NULL OR applied_contact_version > 0),
  ADD CONSTRAINT employee_profile_change_decision_state CHECK (
    (status='pending' AND decision_key IS NULL AND decision_digest IS NULL
      AND decided_by_identity_id IS NULL AND decision_reason IS NULL
      AND decided_at IS NULL AND applied_contact_version IS NULL)
    OR
    (status='rejected' AND decision_key IS NOT NULL AND decision_digest IS NOT NULL
      AND decided_by_identity_id IS NOT NULL
      AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) BETWEEN 3 AND 240
      AND decided_at IS NOT NULL AND applied_contact_version IS NULL)
    OR
    (status='approved' AND decision_key IS NOT NULL AND decision_digest IS NOT NULL
      AND decided_by_identity_id IS NOT NULL
      AND decision_reason IS NOT NULL AND length(btrim(decision_reason)) BETWEEN 3 AND 240
      AND decided_at IS NOT NULL AND applied_contact_version IS NOT NULL)
  );
CREATE UNIQUE INDEX employee_profile_change_decision_key_idx
  ON public.employee_profile_change_requests(tenant_id,decision_key);
CREATE INDEX employee_profile_change_status_created_idx
  ON public.employee_profile_change_requests(tenant_id,status,created_at DESC);

CREATE OR REPLACE FUNCTION public.employee_profile_change_request_json(
  p_request public.employee_profile_change_requests
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'id',p_request.id,'version',p_request.version,'status',p_request.status,
    'expectedContactVersion',p_request.expected_contact_version,
    'personalEmail',p_request.personal_email,'mobilePhone',p_request.mobile_phone,
    'emergencyContactName',p_request.emergency_contact_name,
    'emergencyContactPhone',p_request.emergency_contact_phone,
    'reason',p_request.reason,'decisionReason',p_request.decision_reason,
    'decidedAt',p_request.decided_at,
    'appliedContactVersion',p_request.applied_contact_version,
    'createdAt',p_request.created_at
  )
$$;

CREATE FUNCTION public.read_tenant_profile_change_requests(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT public.tenant_employee_private_authorized(
    p_actor,p_mfa_verified,p_tenant,'employees.private.read'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::varchar,jsonb_build_object('requests',COALESCE((
    SELECT jsonb_agg(
      public.employee_profile_change_request_json(r)
      || jsonb_build_object('employeeId',e.id,'employeeNumber',e.employee_number,'employeeName',e.name)
      ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC
    )
    FROM (SELECT * FROM public.employee_profile_change_requests
      WHERE tenant_id=p_tenant
      ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,created_at DESC,id DESC
      LIMIT 100) r
    JOIN public.employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id
  ),'[]'::jsonb));
END $$;

CREATE FUNCTION public.decide_tenant_profile_change_request(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_request uuid,
  p_decision_key uuid,p_decision_digest varchar,p_expected_version integer,
  p_decision varchar,p_reason varchar,p_details uuid,p_audit uuid,
  p_decision_outbox uuid,p_private_outbox uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request_row public.employee_profile_change_requests%ROWTYPE;
  existing_decision public.employee_profile_change_requests%ROWTYPE;
  current_details public.employee_private_details%ROWTYPE;
  employee_status varchar;
  employee_number varchar;
  employee_name varchar;
  next_contact_version integer;
  decision_snapshot jsonb;
BEGIN
  IF NOT public.tenant_employee_private_authorized(
    p_actor,p_mfa_verified,p_tenant,'employees.private.write'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_decision_key IS NULL OR p_decision_digest IS NULL
    OR p_decision_digest !~ '^[a-f0-9]{64}$'
    OR p_expected_version IS NULL OR p_expected_version<1
    OR p_decision IS NULL OR p_decision NOT IN ('approved','rejected')
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant::text || ':' || p_decision_key::text,0
  ));
  SELECT r.* INTO existing_decision
    FROM public.employee_profile_change_requests r
    WHERE r.tenant_id=p_tenant AND r.decision_key=p_decision_key;
  IF FOUND THEN
    IF existing_decision.id<>p_request OR existing_decision.decision_digest<>p_decision_digest THEN
      RETURN QUERY SELECT 'conflict'::varchar,NULL::jsonb; RETURN;
    END IF;
    SELECT e.employee_number,e.name INTO employee_number,employee_name
      FROM public.employees e
      WHERE e.tenant_id=p_tenant AND e.id=existing_decision.employee_id;
    decision_snapshot := public.employee_profile_change_request_json(existing_decision)
      || jsonb_build_object('employeeId',existing_decision.employee_id,
        'employeeNumber',employee_number,'employeeName',employee_name);
    RETURN QUERY SELECT 'decided'::varchar,decision_snapshot; RETURN;
  END IF;

  SELECT r.employee_id INTO request_row.employee_id
    FROM public.employee_profile_change_requests r
    WHERE r.tenant_id=p_tenant AND r.id=p_request;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  SELECT e.status,e.employee_number,e.name
    INTO employee_status,employee_number,employee_name
    FROM public.employees e
    WHERE e.tenant_id=p_tenant AND e.id=request_row.employee_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  SELECT r.* INTO request_row FROM public.employee_profile_change_requests r
    WHERE r.tenant_id=p_tenant AND r.id=p_request FOR UPDATE;
  IF request_row.status<>'pending' THEN
    RETURN QUERY SELECT 'conflict'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF request_row.version<>p_expected_version THEN
    RETURN QUERY SELECT 'stale'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_decision='approved' THEN
    IF employee_status NOT IN ('draft','active') THEN
      RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
    END IF;
    SELECT d.* INTO current_details FROM public.employee_private_details d
      WHERE d.tenant_id=p_tenant AND d.employee_id=request_row.employee_id FOR UPDATE;
    IF COALESCE(current_details.version,0)<>request_row.expected_contact_version THEN
      RETURN QUERY SELECT 'stale'::varchar,NULL::jsonb; RETURN;
    END IF;
    IF request_row.expected_contact_version=0 THEN
      INSERT INTO public.employee_private_details(
        id,tenant_id,employee_id,personal_email,mobile_phone,
        emergency_contact_name,emergency_contact_phone,updated_by_identity_id
      ) VALUES (
        p_details,p_tenant,request_row.employee_id,request_row.personal_email,
        request_row.mobile_phone,request_row.emergency_contact_name,
        request_row.emergency_contact_phone,p_actor
      );
      next_contact_version := 1;
    ELSE
      IF request_row.personal_email IS NULL AND request_row.mobile_phone IS NULL
        AND request_row.emergency_contact_name IS NULL
        AND current_details.residential_address IS NULL AND current_details.cnic IS NULL THEN
        RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
      END IF;
      next_contact_version := current_details.version+1;
      UPDATE public.employee_private_details d SET
        personal_email=request_row.personal_email,
        mobile_phone=request_row.mobile_phone,
        emergency_contact_name=request_row.emergency_contact_name,
        emergency_contact_phone=request_row.emergency_contact_phone,
        version=next_contact_version,updated_by_identity_id=p_actor,updated_at=now()
      WHERE d.tenant_id=p_tenant AND d.employee_id=request_row.employee_id;
    END IF;
  END IF;

  UPDATE public.employee_profile_change_requests r SET
    status=p_decision,version=r.version+1,decision_key=p_decision_key,
    decision_digest=p_decision_digest,decided_by_identity_id=p_actor,
    decision_reason=btrim(p_reason),decided_at=now(),
    applied_contact_version=CASE WHEN p_decision='approved' THEN next_contact_version ELSE NULL END
    WHERE r.tenant_id=p_tenant AND r.id=p_request RETURNING * INTO request_row;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,
      CASE WHEN p_decision='approved' THEN 'employee.profile_change_approved'
        ELSE 'employee.profile_change_rejected' END,btrim(p_reason),p_request);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_decision_outbox,p_tenant,
      CASE WHEN p_decision='approved' THEN 'employee.profile_change_approved.v1'
        ELSE 'employee.profile_change_rejected.v1' END,p_request,request_row.version);
  IF p_decision='approved' THEN
    INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
      VALUES(p_private_outbox,p_tenant,'employee.private_details_changed.v1',
        request_row.employee_id,next_contact_version);
  END IF;
  decision_snapshot := public.employee_profile_change_request_json(request_row)
    || jsonb_build_object('employeeId',request_row.employee_id,
      'employeeNumber',employee_number,'employeeName',employee_name);
  RETURN QUERY SELECT 'decided'::varchar,decision_snapshot;
END $$;

REVOKE ALL ON FUNCTION public.read_tenant_profile_change_requests(uuid,boolean,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_tenant_profile_change_request(uuid,boolean,uuid,uuid,uuid,varchar,integer,varchar,varchar,uuid,uuid,uuid,uuid) FROM PUBLIC;

COMMIT;
