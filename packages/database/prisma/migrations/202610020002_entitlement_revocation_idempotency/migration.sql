BEGIN;
CREATE TABLE public.entitlement_revocation_receipts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  input jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id, request_id)
);
ALTER TABLE public.entitlement_revocation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlement_revocation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.entitlement_revocation_receipts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE FUNCTION public.revoke_entitlement_change_idempotent(
  p_actor uuid, p_mfa boolean, p_tenant uuid, p_request uuid,
  p_kind varchar, p_change uuid, p_expected_version integer,
  p_reason varchar, p_audit uuid, p_platform_audit uuid
) RETURNS TABLE(outcome text, change_id uuid, change_version integer, entitlement_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_input jsonb; v_receipt public.entitlement_revocation_receipts%ROWTYPE; v_result record;
BEGIN
  IF public.check_platform_operator_access(p_actor,p_mfa) IS NOT TRUE THEN
    RETURN QUERY SELECT 'forbidden'::text,NULL::uuid,NULL::integer,NULL::integer; RETURN;
  END IF;
  IF p_request IS NULL OR p_change IS NULL OR p_kind IS NULL OR p_kind NOT IN ('grant','override') THEN
    RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer,NULL::integer; RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':entitlements',0));
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id=p_tenant AND status='active') THEN
    RETURN QUERY SELECT 'not_found'::text,NULL::uuid,NULL::integer,NULL::integer; RETURN;
  END IF;
  v_input := jsonb_build_object('kind',p_kind,'id',p_change,'expectedVersion',p_expected_version,'reason',p_reason);
  SELECT * INTO v_receipt FROM public.entitlement_revocation_receipts
    WHERE tenant_id=p_tenant AND actor_id=p_actor AND request_id=p_request;
  IF FOUND THEN
    IF v_receipt.input IS DISTINCT FROM v_input THEN
      RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer,NULL::integer; RETURN;
    END IF;
    -- A receipt proves the original revocation; later commercial state is not rewritten.
    RETURN QUERY SELECT 'replayed'::text,(v_receipt.result->>'id')::uuid,
      (v_receipt.result->>'version')::integer,(v_receipt.result->>'entitlementVersion')::integer; RETURN;
  END IF;
  SELECT * INTO v_result FROM public.revoke_entitlement_change(p_actor,p_mfa,p_tenant,p_kind,
    p_change,p_expected_version,p_reason,p_audit,p_platform_audit);
  IF v_result.outcome='revoked' THEN
    INSERT INTO public.entitlement_revocation_receipts(tenant_id,actor_id,request_id,input,result)
      VALUES(p_tenant,p_actor,p_request,v_input,jsonb_build_object('id',v_result.change_id,
        'version',v_result.change_version,'entitlementVersion',v_result.entitlement_version));
  END IF;
  RETURN QUERY SELECT v_result.outcome,v_result.change_id,v_result.change_version,v_result.entitlement_version;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_entitlement_change_idempotent(uuid,boolean,uuid,uuid,varchar,uuid,integer,varchar,uuid,uuid) FROM PUBLIC;
COMMIT;
