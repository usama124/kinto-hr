BEGIN;

ALTER TABLE public.employee_import_batches
  ADD COLUMN request_key uuid,
  ADD COLUMN request_digest char(64);
UPDATE public.employee_import_batches
  SET request_key=gen_random_uuid(),request_digest=file_digest
  WHERE request_key IS NULL;
ALTER TABLE public.employee_import_batches
  ALTER COLUMN request_key SET NOT NULL,
  ALTER COLUMN request_digest SET NOT NULL,
  ALTER COLUMN request_key SET DEFAULT
    NULLIF(current_setting('app.employee_import_request_key',true),'')::uuid,
  ALTER COLUMN request_digest SET DEFAULT
    NULLIF(current_setting('app.employee_import_request_digest',true),'')::char(64);
ALTER TABLE public.employee_import_batches
  ADD CONSTRAINT employee_import_batches_request_digest_check
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT employee_import_batches_tenant_request_key_key
    UNIQUE (tenant_id,request_key);

CREATE FUNCTION public.create_tenant_employee_import_preview_idempotent(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_request_key uuid,
  p_request_digest varchar,p_batch uuid,p_file_name varchar,p_file_digest varchar,
  p_rows jsonb,p_file_errors jsonb,p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE existing public.employee_import_batches%ROWTYPE; created record;
BEGIN
  IF NOT public.tenant_employee_import_authorized(p_actor,p_mfa_verified,p_tenant) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_request_key IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$' THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text,42));
  SELECT b.* INTO existing FROM public.employee_import_batches b
    WHERE b.tenant_id=p_tenant AND b.request_key=p_request_key;
  IF FOUND THEN
    IF existing.request_digest<>p_request_digest THEN
      RETURN QUERY SELECT 'conflict'::varchar,NULL::jsonb; RETURN;
    END IF;
    RETURN QUERY SELECT 'created'::varchar,
      public.employee_import_preview_json(p_tenant,existing.id); RETURN;
  END IF;
  PERFORM set_config('app.employee_import_request_key',p_request_key::text,true);
  PERFORM set_config('app.employee_import_request_digest',p_request_digest,true);
  SELECT * INTO created FROM public.create_tenant_employee_import_preview(
    p_actor,p_mfa_verified,p_tenant,p_batch,p_file_name,p_file_digest,p_rows,
    p_file_errors,p_reason,p_audit,p_outbox
  );
  IF created.outcome<>'created' THEN
    RETURN QUERY SELECT created.outcome::varchar,created.snapshot; RETURN;
  END IF;
  UPDATE public.employee_import_batches b SET request_key=p_request_key,
    request_digest=p_request_digest WHERE b.tenant_id=p_tenant AND b.id=p_batch;
  RETURN QUERY SELECT 'created'::varchar,created.snapshot;
END $$;

REVOKE ALL ON FUNCTION public.create_tenant_employee_import_preview_idempotent(uuid,boolean,uuid,uuid,varchar,uuid,varchar,varchar,jsonb,jsonb,varchar,uuid,uuid) FROM PUBLIC;

COMMIT;
