BEGIN;
CREATE TABLE public.entitlement_creation_receipts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  input jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id, request_id)
);
ALTER TABLE public.entitlement_creation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlement_creation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.entitlement_creation_receipts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE FUNCTION public.create_entitlement_change_idempotent(
  p_actor uuid, p_mfa boolean, p_tenant uuid, p_request uuid,
  p_change uuid, p_type varchar, p_start timestamptz, p_end timestamptz,
  p_limit integer, p_delta integer, p_reason varchar, p_audit uuid, p_platform_audit uuid
) RETURNS TABLE(outcome text, change_id uuid, change_version integer, entitlement_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_input jsonb; v_receipt public.entitlement_creation_receipts%ROWTYPE; v_result record;
BEGIN
  IF public.check_platform_operator_access(p_actor,p_mfa) IS NOT TRUE THEN
    RETURN QUERY SELECT 'forbidden'::text,NULL::uuid,NULL::integer,NULL::integer; RETURN;
  END IF;
  IF p_request IS NULL OR p_type IS NULL OR p_type NOT IN ('capacity_addon','complimentary','employee_limit_override')
    OR (p_type='complimentary' AND p_limit IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.tenants WHERE id=p_tenant AND status='active') THEN
    RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer,NULL::integer; RETURN;
  END IF;
  -- Serialize all creation/revocation for this company, including concurrent exact retries.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':entitlements',0));
  v_input := jsonb_build_object('type',p_type,'start',extract(epoch FROM p_start),'end',extract(epoch FROM p_end),
    'limit',p_limit,'delta',p_delta,'reason',p_reason);
  SELECT * INTO v_receipt FROM public.entitlement_creation_receipts
    WHERE tenant_id=p_tenant AND actor_id=p_actor AND request_id=p_request;
  IF FOUND THEN
    IF v_receipt.input IS DISTINCT FROM v_input THEN
      RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer,NULL::integer; RETURN;
    END IF;
    RETURN QUERY SELECT 'replayed'::text,(v_receipt.result->>'id')::uuid,
      (v_receipt.result->>'version')::integer,(v_receipt.result->>'entitlementVersion')::integer; RETURN;
  END IF;
  SELECT * INTO v_result FROM public.create_entitlement_change(p_actor,p_mfa,p_tenant,p_change,
    p_type,p_start,p_end,p_limit,p_delta,p_reason,p_audit,p_platform_audit);
  IF v_result.outcome='created' THEN
    INSERT INTO public.entitlement_creation_receipts(tenant_id,actor_id,request_id,input,result)
      VALUES(p_tenant,p_actor,p_request,v_input,jsonb_build_object('id',v_result.change_id,
        'version',v_result.change_version,'entitlementVersion',v_result.entitlement_version));
  END IF;
  RETURN QUERY SELECT v_result.outcome,v_result.change_id,v_result.change_version,v_result.entitlement_version;
END;
$$;
REVOKE ALL ON FUNCTION public.create_entitlement_change_idempotent(uuid,boolean,uuid,uuid,uuid,varchar,timestamptz,timestamptz,integer,integer,varchar,uuid,uuid) FROM PUBLIC;
COMMIT;
