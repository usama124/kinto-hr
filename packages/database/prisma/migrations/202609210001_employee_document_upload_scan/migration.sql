BEGIN;

CREATE FUNCTION public.authorize_tenant_employee_document_upload(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid,p_document uuid
) RETURNS TABLE(outcome varchar,upload jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE document public.employee_documents%ROWTYPE;
BEGIN
  IF NOT public.tenant_employee_document_authorized(p_actor,p_mfa_verified,p_tenant,true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT d.* INTO document FROM public.employee_documents d
    WHERE d.tenant_id=p_tenant AND d.employee_id=p_employee AND d.id=p_document;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  IF document.status NOT IN ('awaiting_upload','quarantined') THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  RETURN QUERY SELECT 'authorized'::varchar,jsonb_build_object(
    'storageObjectKey',document.storage_object_key,
    'contentType',document.content_type,'sizeBytes',document.size_bytes,
    'fileDigest',document.content_digest,'status',document.status
  );
END $$;

CREATE FUNCTION public.transition_tenant_employee_document_scan(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid,p_document uuid,
  p_expected_status varchar,p_next_status varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE document public.employee_documents%ROWTYPE;
BEGIN
  IF NOT public.tenant_employee_document_authorized(p_actor,p_mfa_verified,p_tenant,true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF NOT ((p_expected_status='awaiting_upload' AND p_next_status='quarantined')
    OR (p_expected_status='quarantined' AND p_next_status IN ('clean','rejected'))) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT d.* INTO document FROM public.employee_documents d
    WHERE d.tenant_id=p_tenant AND d.employee_id=p_employee AND d.id=p_document FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  IF document.status=p_next_status THEN
    RETURN QUERY SELECT 'updated'::varchar,public.employee_document_json(document); RETURN;
  END IF;
  IF document.status<>p_expected_status THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  UPDATE public.employee_documents d SET status=p_next_status,
    scanned_at=CASE WHEN p_next_status IN ('clean','rejected') THEN now() ELSE NULL END
    WHERE d.tenant_id=p_tenant AND d.id=p_document RETURNING * INTO document;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.document_'||p_next_status,
      'Document upload and scan transition',p_document);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.document_'||p_next_status||'.v1',p_document,
      CASE WHEN p_next_status='quarantined' THEN 2 ELSE 3 END);
  RETURN QUERY SELECT 'updated'::varchar,public.employee_document_json(document);
END $$;

REVOKE ALL ON FUNCTION public.authorize_tenant_employee_document_upload(uuid,boolean,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_tenant_employee_document_scan(uuid,boolean,uuid,uuid,uuid,varchar,varchar,uuid,uuid) FROM PUBLIC;

COMMIT;
