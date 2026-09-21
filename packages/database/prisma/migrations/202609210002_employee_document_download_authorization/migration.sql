BEGIN;

CREATE FUNCTION public.authorize_tenant_employee_document_download(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid,p_document uuid,p_audit uuid
) RETURNS TABLE(outcome varchar,download jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE document public.employee_documents%ROWTYPE;
BEGIN
  IF NOT public.tenant_employee_document_authorized(p_actor,p_mfa_verified,p_tenant,false) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT d.* INTO document FROM public.employee_documents d
    WHERE d.tenant_id=p_tenant AND d.employee_id=p_employee AND d.id=p_document;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  IF document.status<>'clean' OR
     (document.expires_on IS NOT NULL AND document.expires_on<(now() AT TIME ZONE 'Asia/Karachi')::date) THEN
    RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN;
  END IF;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.document_download_authorized',
      'Authorized private document download',p_document);
  RETURN QUERY SELECT 'authorized'::varchar,jsonb_build_object(
    'storageObjectKey',document.storage_object_key,
    'contentType',document.content_type,'sizeBytes',document.size_bytes,
    'fileDigest',document.content_digest
  );
END $$;

REVOKE ALL ON FUNCTION public.authorize_tenant_employee_document_download(uuid,boolean,uuid,uuid,uuid,uuid) FROM PUBLIC;

COMMIT;
