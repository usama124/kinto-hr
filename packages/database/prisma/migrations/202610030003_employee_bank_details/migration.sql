BEGIN;
CREATE TABLE public.employee_bank_details (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  bank_name varchar(120),
  account_title varchar(160),
  account_number varchar(34),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  updated_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,employee_id),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES public.employees(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((bank_name IS NULL AND account_title IS NULL AND account_number IS NULL) OR
    (bank_name IS NOT NULL AND account_title IS NOT NULL AND account_number IS NOT NULL
      AND length(btrim(bank_name)) BETWEEN 1 AND 120 AND length(btrim(account_title)) BETWEEN 1 AND 160
      AND account_number ~ '^[A-Z0-9]{1,34}$'))
);
ALTER TABLE public.employee_bank_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_bank_details FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.employee_bank_details
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE FUNCTION public.tenant_employee_bank_authorized(p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_write boolean)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT coalesce(p_mfa_verified,false) AND EXISTS (
    SELECT 1 FROM public.tenants t JOIN public.memberships m ON m.tenant_id=t.id
      JOIN public.identities i ON i.id=m.identity_id
    WHERE t.id=p_tenant AND t.status='active' AND i.id=p_actor AND i.status='active' AND m.status='active'
      AND ((p_write AND 'payroll_preparer'=ANY(m.roles)) OR
        (NOT p_write AND m.roles && ARRAY['payroll_preparer','payroll_approver']::text[])))
$$;
CREATE FUNCTION public.read_tenant_employee_bank_details(p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid)
RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE details jsonb;
BEGIN
  IF NOT public.tenant_employee_bank_authorized(p_actor,p_mfa_verified,p_tenant,false) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees WHERE tenant_id=p_tenant AND id=p_employee AND joining_date IS NOT NULL) THEN
    RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT jsonb_build_object('id',d.id,'version',d.version,'bankName',d.bank_name,
    'accountTitle',d.account_title,'accountNumber',d.account_number,'updatedAt',d.updated_at)
    INTO details FROM public.employee_bank_details d WHERE d.tenant_id=p_tenant AND d.employee_id=p_employee;
  RETURN QUERY SELECT 'ok'::varchar,jsonb_build_object('details',details);
END $$;
CREATE FUNCTION public.update_tenant_employee_bank_details(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid,p_details uuid,p_expected_version integer,
  p_bank_name varchar,p_account_title varchar,p_account_number varchar,p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,details_id uuid,details_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_details public.employee_bank_details%ROWTYPE;
  result_id uuid; next_version integer; action_name varchar; employee_status varchar;
BEGIN
  -- Serialize membership revocation and role changes with writes.
  PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
  IF NOT public.tenant_employee_bank_authorized(p_actor,p_mfa_verified,p_tenant,true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  IF p_expected_version IS NULL OR p_expected_version<0 OR p_reason IS NULL OR p_reason NOT IN ('initial_setup','account_change','details_correction','clear_details') OR
    ((p_reason='clear_details') <> (p_account_number IS NULL)) OR
    NOT ((p_bank_name IS NULL AND p_account_title IS NULL AND p_account_number IS NULL) OR
      (p_bank_name IS NOT NULL AND p_account_title IS NOT NULL AND p_account_number IS NOT NULL
        AND length(btrim(p_bank_name)) BETWEEN 1 AND 120 AND length(btrim(p_account_title)) BETWEEN 1 AND 160
        AND p_account_number ~ '^[A-Z0-9]{1,34}$')) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  -- Employee lock serializes first capture, concurrent revisions and termination.
  SELECT status INTO employee_status FROM public.employees
    WHERE tenant_id=p_tenant AND id=p_employee AND joining_date IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  IF employee_status NOT IN ('draft','active') THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  SELECT * INTO current_details FROM public.employee_bank_details WHERE tenant_id=p_tenant AND employee_id=p_employee FOR UPDATE;
  IF p_expected_version=0 THEN
    IF FOUND THEN RETURN QUERY SELECT 'stale'::varchar,NULL::uuid,NULL::integer; RETURN; END IF;
    -- Do not create an empty initial record; clearing a saved record is permitted.
    IF p_account_number IS NULL THEN RETURN QUERY SELECT 'invalid_state'::varchar,NULL::uuid,NULL::integer; RETURN; END IF;
    INSERT INTO public.employee_bank_details(id,tenant_id,employee_id,bank_name,account_title,account_number,updated_by_identity_id)
      VALUES(p_details,p_tenant,p_employee,btrim(p_bank_name),btrim(p_account_title),p_account_number,p_actor);
    result_id:=p_details; next_version:=1; action_name:='employee.bank_details_created';
  ELSE
    IF NOT FOUND OR current_details.version<>p_expected_version THEN
      RETURN QUERY SELECT 'stale'::varchar,NULL::uuid,NULL::integer; RETURN;
    END IF;
    result_id:=current_details.id; next_version:=current_details.version+1;
    UPDATE public.employee_bank_details SET bank_name=btrim(p_bank_name),account_title=btrim(p_account_title),
      account_number=p_account_number,version=next_version,updated_by_identity_id=p_actor,updated_at=now()
      WHERE tenant_id=p_tenant AND employee_id=p_employee;
    action_name:=CASE WHEN p_account_number IS NULL THEN 'employee.bank_details_cleared' ELSE 'employee.bank_details_updated' END;
  END IF;
  -- Store only a reviewed reason category; never accept arbitrary private text.
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,action_name,p_reason,p_employee);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.bank_details_changed.v1',p_employee,next_version);
  RETURN QUERY SELECT 'updated'::varchar,result_id,next_version;
END $$;
REVOKE ALL ON public.employee_bank_details FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tenant_employee_bank_authorized(uuid,boolean,uuid,boolean),
 public.read_tenant_employee_bank_details(uuid,boolean,uuid,uuid),
 public.update_tenant_employee_bank_details(uuid,boolean,uuid,uuid,uuid,integer,varchar,varchar,varchar,varchar,uuid,uuid) FROM PUBLIC;
COMMIT;
