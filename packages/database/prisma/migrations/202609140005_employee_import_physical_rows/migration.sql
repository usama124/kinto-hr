BEGIN;

ALTER TABLE public.employee_import_rows
  DROP CONSTRAINT employee_import_rows_row_number_check,
  ADD CONSTRAINT employee_import_rows_row_number_check
    CHECK (row_number BETWEEN 2 AND 65537);

CREATE OR REPLACE FUNCTION public.create_tenant_employee_import_preview(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_batch uuid,
  p_file_name varchar,p_file_digest varchar,p_rows jsonb,p_file_errors jsonb,
  p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; values_json jsonb; row_errors jsonb; row_id uuid;
  total_errors integer; selected_row integer; number_value varchar;
BEGIN
  IF NOT public.tenant_employee_import_authorized(p_actor,p_mfa_verified,p_tenant) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 5 AND 120 OR
    p_file_name !~* '^[A-Za-z0-9][A-Za-z0-9._ -]*\.csv$' OR
    p_file_digest !~ '^[a-f0-9]{64}$' OR p_reason IS NULL OR
    length(btrim(p_reason)) NOT BETWEEN 3 AND 240 OR
    jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>250 OR
    jsonb_typeof(p_file_errors)<>'array' OR jsonb_array_length(p_file_errors)>20 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  INSERT INTO public.employee_import_batches(id,tenant_id,file_name,file_digest,status,
    row_count,error_count,file_errors,created_by_identity_id,reason)
    VALUES(p_batch,p_tenant,btrim(p_file_name),p_file_digest,'invalid',
      jsonb_array_length(p_rows),0,p_file_errors,p_actor,btrim(p_reason));
  FOR item IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF jsonb_typeof(item)<>'object' OR jsonb_typeof(item->'values')<>'object' OR
      jsonb_typeof(item->'errors')<>'array' OR jsonb_array_length(item->'errors')>20 OR
      (item->>'rowNumber') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'invalid employee import row' USING ERRCODE='22023';
    END IF;
    selected_row := (item->>'rowNumber')::integer;
    IF selected_row NOT BETWEEN 2 AND 65537 THEN
      RAISE EXCEPTION 'invalid employee import row number' USING ERRCODE='22023';
    END IF;
    values_json := item->'values';
    row_errors := item->'errors';
    number_value := values_json->>'employeeNumber';
    IF jsonb_array_length(row_errors)=0 THEN
      IF number_value IS NULL OR number_value !~ '^[A-Z0-9][A-Z0-9_-]{0,39}$' OR
        values_json->>'name' IS NULL OR length(btrim(values_json->>'name')) NOT BETWEEN 1 AND 160 OR
        left(btrim(values_json->>'name'),1) IN ('=','+','-','@') OR
        (values_json->>'joiningDate')::date IS NULL THEN
        row_errors := row_errors || '[{"field":"row","code":"invalid_value"}]'::jsonb;
      END IF;
      IF EXISTS (SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant AND e.employee_number=number_value) THEN
        row_errors := row_errors || '[{"field":"employeeNumber","code":"duplicate_employee_number"}]'::jsonb;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.tenant_id=p_tenant
        AND b.code=values_json->>'branchCode' AND b.status='active') THEN
        row_errors := row_errors || '[{"field":"branchCode","code":"unknown_branch"}]'::jsonb;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.tenant_id=p_tenant
        AND d.code=values_json->>'departmentCode' AND d.status='active') THEN
        row_errors := row_errors || '[{"field":"departmentCode","code":"unknown_department"}]'::jsonb;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.designations d WHERE d.tenant_id=p_tenant
        AND d.code=values_json->>'designationCode' AND d.status='active') THEN
        row_errors := row_errors || '[{"field":"designationCode","code":"unknown_designation"}]'::jsonb;
      END IF;
      IF values_json->>'managerEmployeeNumber' IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant
          AND e.employee_number=values_json->>'managerEmployeeNumber' AND e.status IN ('draft','active')) THEN
        row_errors := row_errors || '[{"field":"managerEmployeeNumber","code":"unknown_manager"}]'::jsonb;
      END IF;
    END IF;
    row_id:=gen_random_uuid();
    INSERT INTO public.employee_import_rows(id,tenant_id,batch_id,row_number,normalized_values,errors)
      VALUES(row_id,p_tenant,p_batch,selected_row,values_json,row_errors);
  END LOOP;
  SELECT jsonb_array_length(p_file_errors)+COALESCE(sum(jsonb_array_length(r.errors)),0)::integer
    INTO total_errors FROM public.employee_import_rows r WHERE r.tenant_id=p_tenant AND r.batch_id=p_batch;
  UPDATE public.employee_import_batches SET error_count=total_errors,
    status=CASE WHEN total_errors=0 AND jsonb_array_length(p_rows)>0 THEN 'ready' ELSE 'invalid' END
    WHERE tenant_id=p_tenant AND id=p_batch;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.import_previewed',btrim(p_reason),p_batch);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.import_previewed.v1',p_batch,1);
  RETURN QUERY SELECT 'created'::varchar,public.employee_import_preview_json(p_tenant,p_batch);
END $$;

REVOKE ALL ON FUNCTION public.create_tenant_employee_import_preview(uuid,boolean,uuid,uuid,varchar,varchar,jsonb,jsonb,varchar,uuid,uuid) FROM PUBLIC;

COMMIT;
