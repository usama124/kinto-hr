BEGIN;

CREATE OR REPLACE FUNCTION public.activate_tenant_employee_document_replacement(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid,
  p_document uuid,p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE replacement public.employee_documents%ROWTYPE;
  retired public.employee_documents%ROWTYPE;
BEGIN
  IF NOT public.tenant_employee_document_authorized(p_actor,p_mfa_verified,p_tenant,true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;

  SELECT d.* INTO replacement FROM public.employee_documents d
    WHERE d.tenant_id=p_tenant AND d.employee_id=p_employee AND d.id=p_document
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF replacement.status<>'clean' OR replacement.replacement_document_id IS NULL THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;

  SELECT d.* INTO retired FROM public.employee_documents d
    WHERE d.tenant_id=p_tenant AND d.employee_id=p_employee
      AND d.id=replacement.replacement_document_id
    FOR UPDATE;
  IF NOT FOUND OR retired.category<>replacement.category THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF retired.status='removed' THEN
    IF retired.removal_replacement_document_id=p_document THEN
      RETURN QUERY SELECT 'activated'::varchar,jsonb_build_object(
        'replacement',public.employee_document_json(replacement),
        'retiredDocument',public.employee_document_json(retired)
      ); RETURN;
    END IF;
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF retired.status<>'clean'
    OR (retired.replacement_document_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.employee_documents prior
      WHERE prior.tenant_id=p_tenant
        AND prior.id=retired.replacement_document_id
        AND prior.status='removed'
        AND prior.removal_replacement_document_id=retired.id
    )) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;

  UPDATE public.employee_documents d
    SET status='removed',removed_at=now(),removal_reason=btrim(p_reason),
      removed_by_identity_id=p_actor,removal_replacement_document_id=p_document
    WHERE d.tenant_id=p_tenant AND d.id=retired.id
    RETURNING * INTO retired;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.document_replacement_activated',
      btrim(p_reason),p_document);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.document_replacement_activated.v1',
      p_document,4);
  RETURN QUERY SELECT 'activated'::varchar,jsonb_build_object(
    'replacement',public.employee_document_json(replacement),
    'retiredDocument',public.employee_document_json(retired)
  );
END $$;

REVOKE ALL ON FUNCTION public.activate_tenant_employee_document_replacement(
  uuid,boolean,uuid,uuid,uuid,varchar,uuid,uuid
) FROM PUBLIC;

COMMIT;
