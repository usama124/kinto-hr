BEGIN;

CREATE FUNCTION public.read_tenant_self_employee_documents(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_employee uuid;
BEGIN
  IF NOT p_mfa_verified THEN RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN; END IF;
  SELECT l.employee_id INTO v_employee
  FROM public.employee_identity_links l
  JOIN public.memberships m ON m.id=l.membership_id AND m.tenant_id=l.tenant_id
  JOIN public.identities i ON i.id=l.identity_id
  JOIN public.tenants t ON t.id=l.tenant_id
  WHERE l.tenant_id=p_tenant AND l.identity_id=p_actor AND m.identity_id=p_actor
    AND i.status='active' AND t.status='active' AND m.status='active'
    AND m.roles @> ARRAY['employee']::text[];
  IF NOT FOUND THEN RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::varchar,jsonb_build_object('documents',COALESCE((
    SELECT jsonb_agg(public.employee_document_json(d) ORDER BY d.created_at DESC,d.id DESC)
    FROM (SELECT * FROM public.employee_documents
      WHERE tenant_id=p_tenant AND employee_id=v_employee AND visibility='employee_visible'
        AND status='clean' AND (expires_on IS NULL OR expires_on>=(now() AT TIME ZONE 'Asia/Karachi')::date)
      ORDER BY created_at DESC,id DESC LIMIT 500) d
  ),'[]'::jsonb));
END $$;

CREATE FUNCTION public.authorize_tenant_self_employee_document_download(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_document uuid,p_audit uuid
) RETURNS TABLE(outcome varchar,download jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_employee uuid;
  document public.employee_documents%ROWTYPE;
BEGIN
  IF NOT p_mfa_verified THEN RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN; END IF;
  SELECT l.employee_id INTO v_employee
  FROM public.employee_identity_links l
  JOIN public.memberships m ON m.id=l.membership_id AND m.tenant_id=l.tenant_id
  JOIN public.identities i ON i.id=l.identity_id
  JOIN public.tenants t ON t.id=l.tenant_id
  WHERE l.tenant_id=p_tenant AND l.identity_id=p_actor AND m.identity_id=p_actor
    AND i.status='active' AND t.status='active' AND m.status='active'
    AND m.roles @> ARRAY['employee']::text[];
  IF NOT FOUND THEN RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN; END IF;
  SELECT d.* INTO document FROM public.employee_documents d
    WHERE d.tenant_id=p_tenant AND d.employee_id=v_employee AND d.id=p_document
      AND d.visibility='employee_visible' AND d.status='clean'
      AND (d.expires_on IS NULL OR d.expires_on>=(now() AT TIME ZONE 'Asia/Karachi')::date);
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN; END IF;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.document_self_download_authorized',
      'Authorized own visible document download',p_document);
  RETURN QUERY SELECT 'authorized'::varchar,jsonb_build_object(
    'storageObjectKey',document.storage_object_key,
    'contentType',document.content_type,'sizeBytes',document.size_bytes,
    'fileDigest',document.content_digest
  );
END $$;

REVOKE ALL ON FUNCTION public.read_tenant_self_employee_documents(uuid,boolean,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_tenant_self_employee_document_download(uuid,boolean,uuid,uuid,uuid) FROM PUBLIC;

COMMIT;
