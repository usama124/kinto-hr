BEGIN;

ALTER TABLE public.employee_documents
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removal_reason varchar(240),
  ADD COLUMN removed_by_identity_id uuid REFERENCES public.identities(id) ON DELETE RESTRICT,
  ADD COLUMN removal_replacement_document_id uuid;

UPDATE public.employee_documents
SET removed_at=COALESCE(scanned_at,created_at),
    removal_reason='Legacy logical removal metadata backfill',
    removed_by_identity_id=created_by_identity_id
WHERE status='removed';

ALTER TABLE public.employee_documents
  ADD CONSTRAINT employee_documents_removal_replacement_fk
    FOREIGN KEY (tenant_id,removal_replacement_document_id)
    REFERENCES public.employee_documents(tenant_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT employee_documents_removal_metadata_check CHECK (
    (status='removed' AND removed_at IS NOT NULL
      AND removal_reason IS NOT NULL
      AND length(btrim(removal_reason)) BETWEEN 3 AND 240
      AND removed_by_identity_id IS NOT NULL)
    OR
    (status<>'removed' AND removed_at IS NULL AND removal_reason IS NULL
      AND removed_by_identity_id IS NULL
      AND removal_replacement_document_id IS NULL)
  );

CREATE UNIQUE INDEX employee_documents_removal_replacement_unique
  ON public.employee_documents(tenant_id,removal_replacement_document_id)
  WHERE removal_replacement_document_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.employee_document_json(p_document public.employee_documents)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'id',p_document.id,'employeeId',p_document.employee_id,
    'category',p_document.category,'visibility',p_document.visibility,
    'fileName',p_document.original_file_name,'contentType',p_document.content_type,
    'sizeBytes',p_document.size_bytes,'status',p_document.status,
    'expiresOn',p_document.expires_on,
    'replacementDocumentId',p_document.replacement_document_id,
    'createdAt',p_document.created_at,'scannedAt',p_document.scanned_at,
    'removedAt',p_document.removed_at,'removalReason',p_document.removal_reason,
    'removalReplacementDocumentId',p_document.removal_replacement_document_id
  )
$$;

CREATE FUNCTION public.activate_tenant_employee_document_replacement(
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
  IF retired.status<>'clean' THEN
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

CREATE OR REPLACE FUNCTION public.authorize_tenant_employee_document_download(
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
  IF document.status<>'clean'
     OR (document.expires_on IS NOT NULL
       AND document.expires_on<(now() AT TIME ZONE 'Asia/Karachi')::date)
     OR (document.replacement_document_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.employee_documents target
       WHERE target.tenant_id=p_tenant
         AND target.id=document.replacement_document_id
         AND target.status='removed'
         AND target.removal_replacement_document_id=document.id
     )) THEN
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

CREATE OR REPLACE FUNCTION public.read_tenant_self_employee_documents(
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
    FROM (SELECT candidate.* FROM public.employee_documents candidate
      WHERE candidate.tenant_id=p_tenant AND candidate.employee_id=v_employee
        AND candidate.visibility='employee_visible' AND candidate.status='clean'
        AND (candidate.expires_on IS NULL
          OR candidate.expires_on>=(now() AT TIME ZONE 'Asia/Karachi')::date)
        AND (candidate.replacement_document_id IS NULL OR EXISTS (
          SELECT 1 FROM public.employee_documents target
          WHERE target.tenant_id=p_tenant
            AND target.id=candidate.replacement_document_id
            AND target.status='removed'
            AND target.removal_replacement_document_id=candidate.id
        ))
      ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 500) d
  ),'[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.authorize_tenant_self_employee_document_download(
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
      AND (d.expires_on IS NULL OR d.expires_on>=(now() AT TIME ZONE 'Asia/Karachi')::date)
      AND (d.replacement_document_id IS NULL OR EXISTS (
        SELECT 1 FROM public.employee_documents target
        WHERE target.tenant_id=p_tenant
          AND target.id=d.replacement_document_id
          AND target.status='removed'
          AND target.removal_replacement_document_id=d.id
      ));
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

COMMIT;
