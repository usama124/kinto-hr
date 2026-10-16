BEGIN;
CREATE FUNCTION public.valid_company_calendar_settings(s jsonb, f date) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE h jsonb; last_day date; day date; name text;
 trim_chars text := E' \t\n\r\f' || chr(11) || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
 IF f IS NULL OR f<'0001-01-01'::date OR f>='9999-12-31'::date OR s IS NULL OR jsonb_typeof(s)<>'object'
 OR NOT(s ?& ARRAY['scope','timeZone','coverageUntil','holidays']) OR s-ARRAY['scope','timeZone','coverageUntil','holidays']<>'{}'::jsonb THEN RETURN false; END IF;
 IF jsonb_typeof(s->'scope')<>'string' OR s->>'scope'<>'company' OR jsonb_typeof(s->'timeZone')<>'string' OR s->>'timeZone'<>'Asia/Karachi'
 OR jsonb_typeof(s->'coverageUntil')<>'string' OR s->>'coverageUntil' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 OR jsonb_typeof(s->'holidays')<>'array' OR jsonb_array_length(s->'holidays')>366 THEN RETURN false; END IF;
 last_day:=(s->>'coverageUntil')::date;
 IF last_day<f OR last_day>='9999-12-31'::date OR last_day-f>365 THEN RETURN false; END IF;
 FOR h IN SELECT value FROM jsonb_array_elements(s->'holidays') LOOP
  IF jsonb_typeof(h)<>'object' OR NOT(h ?& ARRAY['date','name']) OR h-ARRAY['date','name']<>'{}'::jsonb
  OR jsonb_typeof(h->'date')<>'string' OR h->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR jsonb_typeof(h->'name')<>'string' THEN RETURN false; END IF;
  day:=(h->>'date')::date; name:=h->>'name';
  IF day<f OR day>last_day OR length(name) NOT BETWEEN 1 AND 120 OR length(name)+(SELECT count(*) FROM regexp_split_to_table(name,'') ch WHERE ascii(ch)>65535)>120 OR btrim(name,trim_chars)<>name THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(*)<>count(DISTINCT value->>'date') FROM jsonb_array_elements(s->'holidays')) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE public.company_policy_versions DROP CONSTRAINT company_policy_versions_domain_check;
ALTER TABLE public.company_policy_versions ADD CONSTRAINT company_policy_versions_domain_check CHECK(domain IN ('organization_defaults','attendance_timing','company_calendar'));
ALTER TABLE public.company_policy_versions DROP CONSTRAINT company_policy_versions_settings_check;
ALTER TABLE public.company_policy_versions ADD CONSTRAINT company_policy_versions_settings_check CHECK(
 (domain='organization_defaults' AND jsonb_typeof(settings)='object' AND settings ? 'defaultBranchId' AND jsonb_typeof(settings->'defaultBranchId')='string'
  AND settings=jsonb_build_object('defaultBranchId',settings->'defaultBranchId') AND (settings->>'defaultBranchId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
 OR (domain='attendance_timing' AND public.valid_attendance_timing_settings(settings))
 OR (domain='company_calendar' AND public.valid_company_calendar_settings(settings,effective_from)));
CREATE TABLE public.company_calendar_receipts (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, input jsonb NOT NULL, policy_id uuid NOT NULL,
 snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,request_id),
 FOREIGN KEY(tenant_id,policy_id) REFERENCES public.company_policy_versions(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE public.company_calendar_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_calendar_receipts FORCE ROW LEVEL SECURITY;
CREATE FUNCTION public.guard_company_calendar_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 -- Administrative superuser restore/fixture cleanup is deliberately separate
 -- from runtime/control function authority. Neither application role is superuser.
 IF (SELECT rolsuper FROM pg_roles WHERE rolname=session_user) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF OLD.domain='company_calendar' OR NEW.domain='company_calendar' THEN
  IF TG_OP='DELETE' OR OLD.status='published' THEN RAISE EXCEPTION 'Calendar policy history is immutable'; END IF;
  IF NEW.status<>'published' OR (to_jsonb(NEW)-ARRAY['status','published_by_identity_id','published_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','published_by_identity_id','published_at']) THEN RAISE EXCEPTION 'Only calendar publication is permitted'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER company_calendar_policy_immutable BEFORE UPDATE OR DELETE ON public.company_policy_versions FOR EACH ROW EXECUTE FUNCTION public.guard_company_calendar_policy();
CREATE FUNCTION public.company_calendar_policy_json(p public.company_policy_versions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',p.id,'version',p.policy_version,'basedOnVersion',p.based_on_version,'status',p.status,
 'effectiveFrom',to_char(p.effective_from,'YYYY-MM-DD'),'effectiveUntil',CASE WHEN p.status='published' THEN to_char(least((p.settings->>'coverageUntil')::date+1,coalesce((SELECT min(n.effective_from) FROM public.company_policy_versions n WHERE n.tenant_id=p.tenant_id AND n.domain='company_calendar' AND n.status='published' AND n.effective_from>p.effective_from),(p.settings->>'coverageUntil')::date+1)),'YYYY-MM-DD') ELSE NULL END,'settings',p.settings,'reason',p.reason,'createdAt',p.created_at,'publishedAt',p.published_at)
$$;
CREATE FUNCTION public.read_company_calendar_policies(p_actor uuid,p_mfa boolean,p_tenant uuid,p_limit integer,p_after uuid,p_asof date)
RETURNS TABLE(outcome text,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d date := coalesce(p_asof,(now() AT TIME ZONE 'Asia/Karachi')::date);
BEGIN
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR d<'0001-01-01'::date OR d>='9999-12-31'::date THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 RETURN QUERY SELECT 'ok'::text,jsonb_build_object('tenantId',p_tenant,'asOf',to_char(d,'YYYY-MM-DD'),
 'latestPublishedVersion',(SELECT coalesce(max(policy_version),0) FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='company_calendar' AND status='published'),
 'currentPolicy',(SELECT public.company_calendar_policy_json(p) FROM public.company_policy_versions p WHERE tenant_id=p_tenant AND domain='company_calendar' AND status='published' AND effective_from<=d AND NOT EXISTS(SELECT 1 FROM public.company_policy_versions n WHERE n.tenant_id=p_tenant AND n.domain='company_calendar' AND n.status='published' AND n.effective_from>p.effective_from AND n.effective_from<=d) AND (settings->>'coverageUntil')::date>=d ORDER BY effective_from DESC,policy_version DESC LIMIT 1),
 'items',coalesce((SELECT jsonb_agg(public.company_calendar_policy_json(p) ORDER BY p.id) FROM (SELECT * FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='company_calendar' AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1) p),'[]'::jsonb));
END $$;
CREATE FUNCTION public.mutate_company_calendar_policy(p_actor uuid,p_mfa boolean,p_tenant uuid,p_request uuid,p_kind varchar,p_policy uuid,p_expected integer,p_effective date,p_settings jsonb,p_reason varchar,p_audit uuid,p_outbox uuid)
RETURNS TABLE(outcome text,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE payload jsonb; receipt public.company_calendar_receipts%ROWTYPE; policy public.company_policy_versions%ROWTYPE;
 current_version integer; next_version integer; new_id uuid; result jsonb;
BEGIN
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_request IS NULL OR p_expected IS NULL OR p_expected<0 OR p_kind IS NULL OR p_kind NOT IN ('create','publish') OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF (p_kind='create' AND (p_policy IS NOT NULL OR p_effective IS NULL OR public.valid_company_calendar_settings(p_settings,p_effective) IS NOT TRUE))
 OR (p_kind='publish' AND (p_policy IS NULL OR p_expected<1 OR p_effective IS NOT NULL OR p_settings IS NOT NULL)) THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 payload:=jsonb_build_object('kind',p_kind,'policyId',p_policy,'expectedVersion',p_expected,'effectiveFrom',p_effective,'settings',p_settings,'reason',btrim(p_reason));
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
   VALUES(new_id,p_tenant,'company_calendar',next_version,current_version,p_effective,p_settings,btrim(p_reason),p_actor);
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
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id) VALUES(p_audit,p_tenant,p_actor,'company_calendar.'||p_kind,btrim(p_reason),new_id);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version) VALUES(p_outbox,p_tenant,'company_calendar.'||p_kind||'.v1',new_id,next_version);
 RETURN QUERY SELECT 'ok'::text,result;
END $$;

CREATE FUNCTION public.resolve_company_calendar_days(p_actor uuid,p_mfa boolean,p_tenant uuid,p_from date,p_until date)
RETURNS TABLE(outcome text,snapshot jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_from IS NULL OR p_until IS NULL OR p_from<'0001-01-01'::date OR p_until>='9999-12-31'::date OR p_until<p_from OR p_until-p_from>365 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 RETURN QUERY SELECT 'ok'::text,jsonb_build_object('tenantId',p_tenant,'from',to_char(p_from,'YYYY-MM-DD'),'until',to_char(p_until,'YYYY-MM-DD'),'days',(
 SELECT jsonb_agg(CASE WHEN c.id IS NULL OR d>(c.settings->>'coverageUntil')::date OR t.id IS NULL THEN
  jsonb_build_object('date',to_char(d,'YYYY-MM-DD'),'calendar','unknown','code',CASE WHEN c.id IS NULL OR d>(c.settings->>'coverageUntil')::date THEN 'CALENDAR_UNRESOLVED' ELSE 'TIMING_UNRESOLVED' END,'calendarPolicy',CASE WHEN c.id IS NOT NULL AND d<=(c.settings->>'coverageUntil')::date THEN jsonb_build_object('id',c.id,'version',c.policy_version) ELSE NULL END,'timingPolicy',CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('id',t.id,'version',t.policy_version) ELSE NULL END)
 ELSE jsonb_build_object('date',to_char(d,'YYYY-MM-DD'),'calendar',CASE WHEN h.name IS NOT NULL THEN 'holiday' WHEN t.settings->'weeklyRestDays' @> jsonb_build_array(extract(isodow FROM d)::integer) THEN 'rest_day' ELSE 'working_day' END,'holidayName',h.name,'calendarPolicy',jsonb_build_object('id',c.id,'version',c.policy_version),'timingPolicy',jsonb_build_object('id',t.id,'version',t.policy_version)) END ORDER BY d)
 FROM (SELECT p_from+i AS d FROM generate_series(0,p_until-p_from) i) dates
 LEFT JOIN LATERAL (SELECT * FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='company_calendar' AND status='published' AND effective_from<=d ORDER BY effective_from DESC,policy_version DESC LIMIT 1) c ON true
 LEFT JOIN LATERAL (SELECT * FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='attendance_timing' AND status='published' AND effective_from<=d ORDER BY effective_from DESC,policy_version DESC LIMIT 1) t ON true
 LEFT JOIN LATERAL (SELECT value->>'name' AS name FROM jsonb_array_elements(c.settings->'holidays') WHERE value->>'date'=to_char(d,'YYYY-MM-DD')) h ON true));
END $$;
REVOKE ALL ON public.company_calendar_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_company_calendar_settings(jsonb,date),public.guard_company_calendar_policy(),public.company_calendar_policy_json(public.company_policy_versions),public.read_company_calendar_policies(uuid,boolean,uuid,integer,uuid,date),public.mutate_company_calendar_policy(uuid,boolean,uuid,uuid,varchar,uuid,integer,date,jsonb,varchar,uuid,uuid),public.resolve_company_calendar_days(uuid,boolean,uuid,date,date) FROM PUBLIC;
COMMIT;
