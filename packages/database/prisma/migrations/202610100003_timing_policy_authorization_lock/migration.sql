BEGIN;
-- Keep membership revocation serialized without expanding the private control
-- role to UPDATE tenant/identity tables merely for row-lock privileges.
CREATE OR REPLACE FUNCTION public.mutate_attendance_timing_policy(p_actor uuid,p_mfa boolean,p_tenant uuid,p_request uuid,p_kind varchar,p_policy uuid,p_expected integer,p_effective date,p_settings jsonb,p_reason varchar,p_audit uuid,p_outbox uuid)
RETURNS TABLE(outcome text,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE payload jsonb; receipt public.attendance_timing_receipts%ROWTYPE; policy public.company_policy_versions%ROWTYPE;
 current_version integer; next_version integer; new_id uuid; result jsonb;
BEGIN
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_request IS NULL OR p_expected IS NULL OR p_expected<0 OR p_kind IS NULL OR p_kind NOT IN ('create','publish') OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF (p_kind='create' AND (p_policy IS NOT NULL OR p_effective IS NULL OR public.valid_attendance_timing_settings(p_settings) IS NOT TRUE))
 OR (p_kind='publish' AND (p_policy IS NULL OR p_expected<1 OR p_effective IS NOT NULL OR p_settings IS NOT NULL)) THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 payload:=jsonb_build_object('kind',p_kind,'policyId',p_policy,'expectedVersion',p_expected,'effectiveFrom',p_effective,'settings',p_settings,'reason',btrim(p_reason));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':attendance_timing',0));
 SELECT * INTO receipt FROM public.attendance_timing_receipts WHERE tenant_id=p_tenant AND actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF receipt.input IS DISTINCT FROM payload THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::text,receipt.snapshot||jsonb_build_object('replayed',true); RETURN;
 END IF;
 SELECT coalesce(max(policy_version),0) INTO current_version FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='attendance_timing' AND status='published';
 IF p_kind='create' THEN
  IF p_expected<>current_version THEN RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN; END IF;
  IF p_effective<(now() AT TIME ZONE 'Asia/Karachi')::date OR EXISTS(SELECT 1 FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='attendance_timing' AND status='published' AND effective_from>=p_effective) THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  SELECT coalesce(max(policy_version),0)+1 INTO next_version FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='attendance_timing';
  new_id:=gen_random_uuid();
  INSERT INTO public.company_policy_versions(id,tenant_id,domain,policy_version,based_on_version,effective_from,settings,reason,created_by_identity_id)
   VALUES(new_id,p_tenant,'attendance_timing',next_version,current_version,p_effective,p_settings,btrim(p_reason),p_actor);
 ELSE
  SELECT * INTO policy FROM public.company_policy_versions WHERE tenant_id=p_tenant AND id=p_policy AND domain='attendance_timing' FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
  IF policy.status<>'draft' OR policy.policy_version<>p_expected OR policy.based_on_version<>current_version THEN RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN; END IF;
  IF policy.effective_from<(now() AT TIME ZONE 'Asia/Karachi')::date OR public.valid_attendance_timing_settings(policy.settings) IS NOT TRUE OR EXISTS(SELECT 1 FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='attendance_timing' AND status='published' AND effective_from>=policy.effective_from) THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  new_id:=policy.id; next_version:=policy.policy_version;
  UPDATE public.company_policy_versions SET status='published',published_by_identity_id=p_actor,published_at=now() WHERE tenant_id=p_tenant AND id=new_id;
 END IF;
 result:=jsonb_build_object('id',new_id,'version',next_version,'replayed',false);
 INSERT INTO public.attendance_timing_receipts(tenant_id,actor_id,request_id,input,policy_id,snapshot) VALUES(p_tenant,p_actor,p_request,payload,new_id,result);
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id) VALUES(p_audit,p_tenant,p_actor,'attendance_timing.'||p_kind,btrim(p_reason),new_id);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version) VALUES(p_outbox,p_tenant,'attendance_timing.'||p_kind||'.v1',new_id,next_version);
 RETURN QUERY SELECT 'ok'::text,result;
END $$;
COMMIT;
