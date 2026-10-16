BEGIN;
-- Match shared ECMAScript trimming/UTF-16 limits for constrained SQL callers.
CREATE OR REPLACE FUNCTION public.mutate_company_calendar_policy(p_actor uuid,p_mfa boolean,p_tenant uuid,p_request uuid,p_kind varchar,p_policy uuid,p_expected integer,p_effective date,p_settings jsonb,p_reason varchar,p_audit uuid,p_outbox uuid)
RETURNS TABLE(outcome text,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE payload jsonb; receipt public.company_calendar_receipts%ROWTYPE; policy public.company_policy_versions%ROWTYPE;
 trim_chars text := E' \t\n\r\f' || chr(11) || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
 normalized_reason text;
 current_version integer; next_version integer; new_id uuid; result jsonb;
BEGIN
 normalized_reason:=btrim(p_reason,trim_chars);
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_request IS NULL OR p_expected IS NULL OR p_expected<0 OR p_kind IS NULL OR p_kind NOT IN ('create','publish') OR p_reason IS NULL OR length(normalized_reason) NOT BETWEEN 3 AND 240 OR length(normalized_reason)+(SELECT count(*) FROM regexp_split_to_table(normalized_reason,'') ch WHERE ascii(ch)>65535)>240 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF (p_kind='create' AND (p_policy IS NOT NULL OR p_effective IS NULL OR public.valid_company_calendar_settings(p_settings,p_effective) IS NOT TRUE))
 OR (p_kind='publish' AND (p_policy IS NULL OR p_expected<1 OR p_effective IS NOT NULL OR p_settings IS NOT NULL)) THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 payload:=jsonb_build_object('kind',p_kind,'policyId',p_policy,'expectedVersion',p_expected,'effectiveFrom',p_effective,'settings',p_settings,'reason',normalized_reason);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':company_calendar',0));
 SELECT * INTO receipt FROM public.company_calendar_receipts WHERE tenant_id=p_tenant AND actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF receipt.input IS DISTINCT FROM payload THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::text,receipt.snapshot||jsonb_build_object('replayed',true); RETURN;
 END IF;
 SELECT coalesce(max(policy_version),0) INTO current_version FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='company_calendar' AND status='published';
 IF p_kind='create' THEN
  IF p_expected<>current_version THEN RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN; END IF;
  IF p_effective<(now() AT TIME ZONE 'Asia/Karachi')::date OR EXISTS(SELECT 1 FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='company_calendar' AND status='published' AND effective_from>=p_effective) THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  IF (SELECT coalesce(max(policy_version),0) FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='company_calendar')>=2147483647 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
  SELECT coalesce(max(policy_version),0)+1 INTO next_version FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='company_calendar';
  new_id:=gen_random_uuid();
  INSERT INTO public.company_policy_versions(id,tenant_id,domain,policy_version,based_on_version,effective_from,settings,reason,created_by_identity_id)
   VALUES(new_id,p_tenant,'company_calendar',next_version,current_version,p_effective,p_settings,normalized_reason,p_actor);
 ELSE
  SELECT * INTO policy FROM public.company_policy_versions WHERE tenant_id=p_tenant AND id=p_policy AND domain='company_calendar' FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
  IF policy.status<>'draft' OR policy.policy_version<>p_expected OR policy.based_on_version<>current_version THEN RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN; END IF;
  IF policy.effective_from<(now() AT TIME ZONE 'Asia/Karachi')::date OR public.valid_company_calendar_settings(policy.settings,policy.effective_from) IS NOT TRUE OR EXISTS(SELECT 1 FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='company_calendar' AND status='published' AND effective_from>=policy.effective_from) THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  new_id:=policy.id; next_version:=policy.policy_version;
  UPDATE public.company_policy_versions SET status='published',published_by_identity_id=p_actor,published_at=now() WHERE tenant_id=p_tenant AND id=new_id;
 END IF;
 result:=jsonb_build_object('id',new_id,'version',next_version,'replayed',false);
 INSERT INTO public.company_calendar_receipts(tenant_id,actor_id,request_id,input,policy_id,snapshot) VALUES(p_tenant,p_actor,p_request,payload,new_id,result);
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id) VALUES(p_audit,p_tenant,p_actor,'company_calendar.'||p_kind,normalized_reason,new_id);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version) VALUES(p_outbox,p_tenant,'company_calendar.'||p_kind||'.v1',new_id,next_version);
 RETURN QUERY SELECT 'ok'::text,result;
END $$;

COMMIT;
