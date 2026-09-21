BEGIN;

CREATE TABLE public.employee_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  category varchar(20) NOT NULL CHECK (category IN ('identity','employment','education','medical','tax','bank','other')),
  visibility varchar(20) NOT NULL CHECK (visibility IN ('hr_only','employee_visible')),
  original_file_name varchar(180) NOT NULL CHECK (length(btrim(original_file_name)) BETWEEN 1 AND 180),
  content_type varchar(40) NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg','image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  content_digest char(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  storage_object_key varchar(255) NOT NULL CHECK (storage_object_key ~ '^[a-f0-9]{2}/[a-f0-9-]{36}$'),
  status varchar(20) NOT NULL DEFAULT 'awaiting_upload'
    CHECK (status IN ('awaiting_upload','quarantined','clean','rejected','removed')),
  expires_on date,
  replacement_document_id uuid,
  request_key uuid NOT NULL,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  scanned_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,request_key),
  UNIQUE (tenant_id,storage_object_key),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES public.employees(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,replacement_document_id) REFERENCES public.employee_documents(tenant_id,id) ON DELETE RESTRICT,
  CHECK (replacement_document_id IS NULL OR replacement_document_id<>id),
  CHECK ((status IN ('clean','rejected') AND scanned_at IS NOT NULL)
    OR (status IN ('awaiting_upload','quarantined') AND scanned_at IS NULL)
    OR status='removed')
);

CREATE INDEX employee_documents_employee_created_idx
  ON public.employee_documents(tenant_id,employee_id,created_at DESC);

ALTER TABLE public.employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.employee_documents
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION public.tenant_employee_document_authorized(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_write boolean
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT p_mfa_verified AND EXISTS (
    SELECT 1 FROM public.tenants t
    JOIN public.memberships m ON m.tenant_id=t.id
    JOIN public.identities i ON i.id=m.identity_id
    WHERE t.id=p_tenant AND t.status='active' AND i.id=p_actor
      AND i.status='active' AND m.status='active'
      AND m.roles && ARRAY['owner','hr_admin']::text[]
  )
$$;

CREATE FUNCTION public.employee_document_json(p_document public.employee_documents)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT jsonb_build_object(
    'id',p_document.id,'employeeId',p_document.employee_id,
    'category',p_document.category,'visibility',p_document.visibility,
    'fileName',p_document.original_file_name,'contentType',p_document.content_type,
    'sizeBytes',p_document.size_bytes,'status',p_document.status,
    'expiresOn',p_document.expires_on,
    'replacementDocumentId',p_document.replacement_document_id,
    'createdAt',p_document.created_at,'scannedAt',p_document.scanned_at
  )
$$;

CREATE FUNCTION public.register_tenant_employee_document(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid,
  p_document uuid,p_request_key uuid,p_request_digest varchar,p_storage_key varchar,
  p_category varchar,p_visibility varchar,p_file_name varchar,p_content_type varchar,
  p_size_bytes integer,p_content_digest varchar,p_expires_on date,
  p_replacement_document uuid,p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE existing public.employee_documents%ROWTYPE;
  created public.employee_documents%ROWTYPE;
BEGIN
  IF NOT public.tenant_employee_document_authorized(p_actor,p_mfa_verified,p_tenant,true) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_request_digest !~ '^[a-f0-9]{64}$' OR p_storage_key !~ '^[a-f0-9]{2}/[a-f0-9-]{36}$'
    OR p_category NOT IN ('identity','employment','education','medical','tax','bank','other')
    OR p_visibility NOT IN ('hr_only','employee_visible')
    OR p_file_name IS NULL OR length(btrim(p_file_name)) NOT BETWEEN 1 AND 180
    OR p_content_type NOT IN ('application/pdf','image/jpeg','image/png')
    OR p_size_bytes NOT BETWEEN 1 AND 10485760 OR p_content_digest !~ '^[a-f0-9]{64}$'
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text,43));
  SELECT d.* INTO existing FROM public.employee_documents d
    WHERE d.tenant_id=p_tenant AND d.request_key=p_request_key;
  IF FOUND THEN
    IF existing.request_digest<>p_request_digest OR existing.employee_id<>p_employee THEN
      RETURN QUERY SELECT 'conflict'::varchar,NULL::jsonb; RETURN;
    END IF;
    RETURN QUERY SELECT 'registered'::varchar,public.employee_document_json(existing); RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant
    AND e.id=p_employee AND e.joining_date IS NOT NULL) THEN
    RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_replacement_document IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.employee_documents d WHERE d.tenant_id=p_tenant
      AND d.id=p_replacement_document AND d.employee_id=p_employee AND d.status<>'removed'
  ) THEN RETURN QUERY SELECT 'invalid_state'::varchar,NULL::jsonb; RETURN; END IF;
  INSERT INTO public.employee_documents(
    id,tenant_id,employee_id,category,visibility,original_file_name,content_type,
    size_bytes,content_digest,storage_object_key,expires_on,replacement_document_id,
    request_key,request_digest,created_by_identity_id
  ) VALUES (
    p_document,p_tenant,p_employee,p_category,p_visibility,btrim(p_file_name),p_content_type,
    p_size_bytes,p_content_digest,p_storage_key,p_expires_on,p_replacement_document,
    p_request_key,p_request_digest,p_actor
  ) RETURNING * INTO created;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.document_registered',btrim(p_reason),p_document);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.document_registered.v1',p_document,1);
  RETURN QUERY SELECT 'registered'::varchar,public.employee_document_json(created);
END $$;

CREATE FUNCTION public.read_tenant_employee_documents(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT public.tenant_employee_document_authorized(p_actor,p_mfa_verified,p_tenant,false) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant
    AND e.id=p_employee AND e.joining_date IS NOT NULL) THEN
    RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN;
  END IF;
  RETURN QUERY SELECT 'ok'::varchar,jsonb_build_object('documents',COALESCE((
    SELECT jsonb_agg(public.employee_document_json(d) ORDER BY d.created_at DESC,d.id DESC)
    FROM (SELECT * FROM public.employee_documents WHERE tenant_id=p_tenant
      AND employee_id=p_employee ORDER BY created_at DESC,id DESC LIMIT 500) d
  ),'[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION public.tenant_employee_document_authorized(uuid,boolean,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.employee_document_json(public.employee_documents) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_tenant_employee_document(uuid,boolean,uuid,uuid,uuid,uuid,varchar,varchar,varchar,varchar,varchar,varchar,integer,varchar,date,uuid,varchar,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_tenant_employee_documents(uuid,boolean,uuid,uuid) FROM PUBLIC;

COMMIT;
