BEGIN;

CREATE TABLE public.employee_import_batches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  file_name varchar(120) NOT NULL,
  file_digest char(64) NOT NULL CHECK (file_digest ~ '^[a-f0-9]{64}$'),
  preview_revision integer NOT NULL DEFAULT 1 CHECK (preview_revision > 0),
  status varchar(20) NOT NULL CHECK (status IN ('ready','invalid')),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 250),
  error_count integer NOT NULL CHECK (error_count >= 0),
  file_errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(file_errors)='array'),
  created_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  reason varchar(240) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);
CREATE INDEX employee_import_batches_recent
  ON public.employee_import_batches(tenant_id,created_at DESC);

CREATE TABLE public.employee_import_rows (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number BETWEEN 2 AND 251),
  normalized_values jsonb NOT NULL CHECK (jsonb_typeof(normalized_values)='object'),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,batch_id,row_number),
  FOREIGN KEY (tenant_id,batch_id) REFERENCES public.employee_import_batches(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE public.employee_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.employee_import_batches
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE public.employee_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.employee_import_rows
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION public.tenant_employee_import_authorized(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT public.tenant_people_authorized(p_actor,p_mfa_verified,p_tenant,true)
$$;

CREATE FUNCTION public.employee_import_preview_json(p_tenant uuid,p_batch uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'id',b.id,'fileName',b.file_name,'fileDigest',b.file_digest,
    'previewRevision',b.preview_revision,'status',b.status,
    'rowCount',b.row_count,'errorCount',b.error_count,
    'fileErrors',b.file_errors,'createdAt',b.created_at,
    'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'rowNumber',r.row_number,'values',r.normalized_values,'errors',r.errors
    ) ORDER BY r.row_number) FROM public.employee_import_rows r
      WHERE r.tenant_id=b.tenant_id AND r.batch_id=b.id),'[]'::jsonb)
  ) FROM public.employee_import_batches b WHERE b.tenant_id=p_tenant AND b.id=p_batch
$$;

CREATE FUNCTION public.create_tenant_employee_import_preview(
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
    IF selected_row NOT BETWEEN 2 AND 251 THEN
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

CREATE FUNCTION public.read_tenant_employee_import_preview(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_batch uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF NOT public.tenant_employee_import_authorized(p_actor,p_mfa_verified,p_tenant) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  result:=public.employee_import_preview_json(p_tenant,p_batch);
  IF result IS NULL THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::varchar,result;
END $$;

REVOKE ALL ON FUNCTION public.tenant_employee_import_authorized(uuid,boolean,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee_import_preview_json(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_tenant_employee_import_preview(uuid,boolean,uuid,uuid,varchar,varchar,jsonb,jsonb,varchar,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_tenant_employee_import_preview(uuid,boolean,uuid,uuid) FROM PUBLIC;

COMMIT;
