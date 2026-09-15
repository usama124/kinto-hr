BEGIN;

ALTER TABLE public.employee_import_batches
  DROP CONSTRAINT employee_import_batches_status_check,
  ADD CONSTRAINT employee_import_batches_status_check
    CHECK (status IN ('ready','invalid','committed')),
  ADD COLUMN confirmation_request_key uuid,
  ADD COLUMN confirmation_request_digest char(64),
  ADD COLUMN committed_by_identity_id uuid REFERENCES public.identities(id) ON DELETE RESTRICT,
  ADD COLUMN commit_reason varchar(240),
  ADD COLUMN committed_at timestamptz,
  ADD CONSTRAINT employee_import_batches_confirmation_digest_check CHECK (
    confirmation_request_digest IS NULL OR confirmation_request_digest ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT employee_import_batches_commit_state_check CHECK (
    (status='committed' AND confirmation_request_key IS NOT NULL
      AND confirmation_request_digest IS NOT NULL AND committed_by_identity_id IS NOT NULL
      AND length(btrim(commit_reason)) BETWEEN 3 AND 240 AND committed_at IS NOT NULL)
    OR
    (status='invalid' AND confirmation_request_key IS NOT NULL
      AND confirmation_request_digest IS NOT NULL AND committed_by_identity_id IS NULL
      AND commit_reason IS NULL AND committed_at IS NULL)
    OR
    (status IN ('ready','invalid') AND confirmation_request_key IS NULL
      AND confirmation_request_digest IS NULL AND committed_by_identity_id IS NULL
      AND commit_reason IS NULL AND committed_at IS NULL)
  ),
  ADD CONSTRAINT employee_import_batches_tenant_confirmation_key_key
    UNIQUE (tenant_id,confirmation_request_key);

ALTER TABLE public.employee_import_rows
  ADD COLUMN employee_id uuid,
  ADD CONSTRAINT employee_import_rows_employee_fkey
    FOREIGN KEY (tenant_id,employee_id) REFERENCES public.employees(tenant_id,id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.employee_import_preview_json(p_tenant uuid,p_batch uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'id',b.id,'fileName',b.file_name,'fileDigest',b.file_digest,
    'previewRevision',b.preview_revision,'status',b.status,
    'rowCount',b.row_count,'errorCount',b.error_count,
    'fileErrors',b.file_errors,'createdAt',b.created_at,'committedAt',b.committed_at,
    'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'rowNumber',r.row_number,'values',r.normalized_values,'errors',r.errors
    ) ORDER BY r.row_number) FROM public.employee_import_rows r
      WHERE r.tenant_id=b.tenant_id AND r.batch_id=b.id),'[]'::jsonb),
    'employees',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'rowNumber',r.row_number,'employeeId',e.id,'employeeNumber',e.employee_number,
      'status',e.status,'version',e.version
    ) ORDER BY r.row_number) FROM public.employee_import_rows r
      JOIN public.employees e ON e.tenant_id=r.tenant_id AND e.id=r.employee_id
      WHERE r.tenant_id=b.tenant_id AND r.batch_id=b.id),'[]'::jsonb)
  ) FROM public.employee_import_batches b WHERE b.tenant_id=p_tenant AND b.id=p_batch
$$;

CREATE FUNCTION public.confirm_tenant_employee_import(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_batch uuid,
  p_request_key uuid,p_request_digest varchar,p_preview_revision integer,
  p_file_digest varchar,p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  batch public.employee_import_batches%ROWTYPE;
  keyed_batch public.employee_import_batches%ROWTYPE;
  import_row public.employee_import_rows%ROWTYPE;
  values_json jsonb;
  row_errors jsonb;
  validation_errors integer:=0;
  entitlement jsonb;
  employee_limit integer;
  active_employees integer;
  branch_id uuid;
  department_id uuid;
  designation_id uuid;
  manager_id uuid;
  new_employee_id uuid;
  new_period_id uuid;
BEGIN
  IF NOT public.tenant_employee_import_authorized(p_actor,p_mfa_verified,p_tenant) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_request_key IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$' OR
    p_preview_revision<1 OR p_file_digest !~ '^[a-f0-9]{64}$' OR
    p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text,42));
  SELECT b.* INTO keyed_batch FROM public.employee_import_batches b
    WHERE b.tenant_id=p_tenant AND b.confirmation_request_key=p_request_key;
  IF FOUND THEN
    IF keyed_batch.id<>p_batch OR keyed_batch.confirmation_request_digest<>p_request_digest THEN
      RETURN QUERY SELECT 'conflict'::varchar,NULL::jsonb; RETURN;
    END IF;
    RETURN QUERY SELECT CASE WHEN keyed_batch.status='committed'
      THEN 'committed' ELSE 'validation_failed' END::varchar,
      public.employee_import_preview_json(p_tenant,keyed_batch.id); RETURN;
  END IF;

  SELECT b.* INTO batch FROM public.employee_import_batches b
    WHERE b.tenant_id=p_tenant AND b.id=p_batch FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  IF batch.preview_revision<>p_preview_revision OR batch.file_digest<>p_file_digest THEN
    RETURN QUERY SELECT 'stale'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF batch.status='committed' THEN
    RETURN QUERY SELECT 'committed'::varchar,
      public.employee_import_preview_json(p_tenant,p_batch); RETURN;
  END IF;
  IF batch.status<>'ready' OR batch.error_count<>0 OR batch.row_count<1 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text,41));
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text,0));

  FOR import_row IN SELECT r.* FROM public.employee_import_rows r
    WHERE r.tenant_id=p_tenant AND r.batch_id=p_batch ORDER BY r.row_number FOR UPDATE
  LOOP
    values_json:=import_row.normalized_values;
    row_errors:='[]'::jsonb;
    IF EXISTS (SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant
      AND e.employee_number=values_json->>'employeeNumber') THEN
      row_errors:=row_errors||'[{"field":"employeeNumber","code":"duplicate_employee_number"}]'::jsonb;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.tenant_id=p_tenant
      AND b.code=values_json->>'branchCode' AND b.status='active') THEN
      row_errors:=row_errors||'[{"field":"branchCode","code":"unknown_branch"}]'::jsonb;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.tenant_id=p_tenant
      AND d.code=values_json->>'departmentCode' AND d.status='active') THEN
      row_errors:=row_errors||'[{"field":"departmentCode","code":"unknown_department"}]'::jsonb;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.designations d WHERE d.tenant_id=p_tenant
      AND d.code=values_json->>'designationCode' AND d.status='active') THEN
      row_errors:=row_errors||'[{"field":"designationCode","code":"unknown_designation"}]'::jsonb;
    END IF;
    IF values_json->>'managerEmployeeNumber' IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant
        AND e.employee_number=values_json->>'managerEmployeeNumber' AND e.status='active') THEN
      row_errors:=row_errors||'[{"field":"managerEmployeeNumber","code":"unknown_manager"}]'::jsonb;
    END IF;
    UPDATE public.employee_import_rows r SET errors=row_errors
      WHERE r.tenant_id=p_tenant AND r.id=import_row.id;
    validation_errors:=validation_errors+jsonb_array_length(row_errors);
  END LOOP;

  IF validation_errors>0 THEN
    UPDATE public.employee_import_batches b SET status='invalid',error_count=validation_errors,
      preview_revision=preview_revision+1,confirmation_request_key=p_request_key,
      confirmation_request_digest=p_request_digest WHERE b.tenant_id=p_tenant AND b.id=p_batch;
    RETURN QUERY SELECT 'validation_failed'::varchar,
      public.employee_import_preview_json(p_tenant,p_batch); RETURN;
  END IF;

  entitlement:=public.resolve_tenant_entitlements_at(p_tenant,now(),NULL,NULL,NULL);
  IF entitlement IS NULL THEN
    RETURN QUERY SELECT 'tenant_unavailable'::varchar,NULL::jsonb; RETURN;
  END IF;
  employee_limit:=(entitlement->>'employeeLimit')::integer;
  SELECT count(*)::integer INTO active_employees FROM public.employees e
    WHERE e.tenant_id=p_tenant AND e.status='active';
  IF active_employees+batch.row_count>employee_limit THEN
    RETURN QUERY SELECT 'capacity_reached'::varchar,NULL::jsonb; RETURN;
  END IF;

  FOR import_row IN SELECT r.* FROM public.employee_import_rows r
    WHERE r.tenant_id=p_tenant AND r.batch_id=p_batch ORDER BY r.row_number
  LOOP
    values_json:=import_row.normalized_values;
    SELECT b.id INTO STRICT branch_id FROM public.branches b WHERE b.tenant_id=p_tenant
      AND b.code=values_json->>'branchCode' AND b.status='active';
    SELECT d.id INTO STRICT department_id FROM public.departments d WHERE d.tenant_id=p_tenant
      AND d.code=values_json->>'departmentCode' AND d.status='active';
    SELECT d.id INTO STRICT designation_id FROM public.designations d WHERE d.tenant_id=p_tenant
      AND d.code=values_json->>'designationCode' AND d.status='active';
    manager_id:=NULL;
    IF values_json->>'managerEmployeeNumber' IS NOT NULL THEN
      SELECT e.id INTO STRICT manager_id FROM public.employees e WHERE e.tenant_id=p_tenant
        AND e.employee_number=values_json->>'managerEmployeeNumber' AND e.status='active';
    END IF;
    new_employee_id:=gen_random_uuid();
    new_period_id:=gen_random_uuid();
    INSERT INTO public.employees(id,tenant_id,employee_number,name,legal_name,joining_date,
      employment_type,status,version)
      VALUES(new_employee_id,p_tenant,values_json->>'employeeNumber',values_json->>'name',
        values_json->>'legalName',(values_json->>'joiningDate')::date,
        'monthly_salaried','active',2);
    INSERT INTO public.employment_periods(id,tenant_id,employee_id,period_number,
      joining_date,status) VALUES(new_period_id,p_tenant,new_employee_id,1,
        (values_json->>'joiningDate')::date,'active');
    INSERT INTO public.employee_assignments(id,tenant_id,employee_id,employment_period_id,
      branch_id,department_id,designation_id,manager_employee_id,top_level_reason,
      effective_from,created_by_identity_id)
      VALUES(gen_random_uuid(),p_tenant,new_employee_id,new_period_id,branch_id,department_id,
        designation_id,manager_id,values_json->>'topLevelReason',
        (values_json->>'joiningDate')::date,p_actor);
    INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id) VALUES
      (gen_random_uuid(),p_tenant,p_actor,'employee.draft_created',btrim(p_reason),new_employee_id),
      (gen_random_uuid(),p_tenant,p_actor,'employee.activated',btrim(p_reason),new_employee_id);
    INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version) VALUES
      (gen_random_uuid(),p_tenant,'employee.draft_created.v1',new_employee_id,1),
      (gen_random_uuid(),p_tenant,'employee.activated.v1',new_employee_id,2);
    UPDATE public.employee_import_rows r SET employee_id=new_employee_id
      WHERE r.tenant_id=p_tenant AND r.id=import_row.id;
  END LOOP;

  UPDATE public.employee_import_batches b SET status='committed',
    confirmation_request_key=p_request_key,confirmation_request_digest=p_request_digest,
    committed_by_identity_id=p_actor,commit_reason=btrim(p_reason),committed_at=now()
    WHERE b.tenant_id=p_tenant AND b.id=p_batch;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.import_committed',btrim(p_reason),p_batch);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.import_committed.v1',p_batch,p_preview_revision);
  RETURN QUERY SELECT 'committed'::varchar,
    public.employee_import_preview_json(p_tenant,p_batch);
END $$;

REVOKE ALL ON FUNCTION public.confirm_tenant_employee_import(uuid,boolean,uuid,uuid,uuid,varchar,integer,varchar,varchar,uuid,uuid) FROM PUBLIC;

COMMIT;
