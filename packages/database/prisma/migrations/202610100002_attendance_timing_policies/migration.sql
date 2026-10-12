BEGIN;
CREATE FUNCTION public.valid_attendance_timing_settings(s jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text; v numeric; duration integer; net integer;
 keys text[] := ARRAY['scope','timeZone','checkIn','checkOut','checkOutNextDay','breakMode','unpaidBreakMinutes','fullDayTargetMinutes','halfDayTargetMinutes','minimumFullDayMinutes','minimumHalfDayMinutes','lateGraceMinutes','earlyGraceMinutes','associationBeforeMinutes','associationAfterMinutes','weeklyRestDays'];
BEGIN
 IF s IS NULL OR jsonb_typeof(s)<>'object' OR NOT(s ?& keys) OR s-keys<>'{}'::jsonb THEN RETURN false; END IF;
 IF s->>'scope'<>'company' OR s->>'timeZone'<>'Asia/Karachi' OR s->>'breakMode'<>'fixed_duration'
 OR jsonb_typeof(s->'scope')<>'string' OR jsonb_typeof(s->'timeZone')<>'string' OR jsonb_typeof(s->'breakMode')<>'string'
 OR jsonb_typeof(s->'checkIn')<>'string' OR jsonb_typeof(s->'checkOut')<>'string' OR jsonb_typeof(s->'checkOutNextDay')<>'boolean'
 OR s->>'checkIn' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR s->>'checkOut' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['unpaidBreakMinutes','fullDayTargetMinutes','halfDayTargetMinutes','minimumFullDayMinutes','minimumHalfDayMinutes','lateGraceMinutes','earlyGraceMinutes','associationBeforeMinutes','associationAfterMinutes'] LOOP
  IF jsonb_typeof(s->k)<>'number' THEN RETURN false; END IF;
  v := (s->>k)::numeric;
  IF v<>trunc(v) OR v<0 OR v>1439 THEN RETURN false; END IF;
 END LOOP;
 IF (s->>'fullDayTargetMinutes')::integer<1 OR (s->>'halfDayTargetMinutes')::integer<1 OR (s->>'minimumFullDayMinutes')::integer<1 OR (s->>'minimumHalfDayMinutes')::integer<1 THEN RETURN false; END IF;
 duration := substring(s->>'checkOut',1,2)::integer*60+substring(s->>'checkOut',4,2)::integer
  + CASE WHEN (s->>'checkOutNextDay')::boolean THEN 1440 ELSE 0 END
  - substring(s->>'checkIn',1,2)::integer*60-substring(s->>'checkIn',4,2)::integer;
 net := duration-(s->>'unpaidBreakMinutes')::integer;
 IF duration<=0 OR duration>=1440 OR net<=0 OR (s->>'fullDayTargetMinutes')::integer>net
 OR (s->>'halfDayTargetMinutes')::integer>=(s->>'fullDayTargetMinutes')::integer
 OR (s->>'minimumFullDayMinutes')::integer>(s->>'fullDayTargetMinutes')::integer
 OR (s->>'minimumHalfDayMinutes')::integer>=(s->>'minimumFullDayMinutes')::integer
 OR (s->>'minimumHalfDayMinutes')::integer>(s->>'halfDayTargetMinutes')::integer
 OR (s->>'lateGraceMinutes')::integer>net OR (s->>'earlyGraceMinutes')::integer>net
 OR (s->>'associationBeforeMinutes')::integer+duration+(s->>'associationAfterMinutes')::integer>1440 THEN RETURN false; END IF;
 IF jsonb_typeof(s->'weeklyRestDays')<>'array' OR jsonb_array_length(s->'weeklyRestDays')>6 THEN RETURN false; END IF;
 FOR k IN SELECT value::text FROM jsonb_array_elements(s->'weeklyRestDays') LOOP
  v := k::numeric;
  IF v<>trunc(v) OR v<1 OR v>7 THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(s->'weeklyRestDays')) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE public.company_policy_versions DROP CONSTRAINT company_policy_versions_domain_check;
ALTER TABLE public.company_policy_versions ADD CONSTRAINT company_policy_versions_domain_check CHECK(domain IN ('organization_defaults','attendance_timing'));
ALTER TABLE public.company_policy_versions DROP CONSTRAINT company_policy_versions_settings_check;
ALTER TABLE public.company_policy_versions ADD CONSTRAINT company_policy_versions_settings_check CHECK(
 (domain='organization_defaults' AND jsonb_typeof(settings)='object' AND settings ? 'defaultBranchId' AND jsonb_typeof(settings->'defaultBranchId')='string'
  AND settings=jsonb_build_object('defaultBranchId',settings->'defaultBranchId') AND (settings->>'defaultBranchId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
 OR (domain='attendance_timing' AND public.valid_attendance_timing_settings(settings)));
CREATE TABLE public.attendance_timing_receipts (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, input jsonb NOT NULL, policy_id uuid NOT NULL,
 snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,request_id),
 FOREIGN KEY(tenant_id,policy_id) REFERENCES public.company_policy_versions(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE public.attendance_timing_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_timing_receipts FORCE ROW LEVEL SECURITY;
CREATE FUNCTION public.guard_attendance_timing_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 -- Administrative superuser restore/fixture cleanup is deliberately separate
 -- from runtime/control function authority. Neither application role is superuser.
 IF (SELECT rolsuper FROM pg_roles WHERE rolname=session_user) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF OLD.domain='attendance_timing' THEN
  IF TG_OP='DELETE' OR OLD.status='published' THEN RAISE EXCEPTION 'Timing policy history is immutable'; END IF;
  IF NEW.status<>'published' OR (to_jsonb(NEW)-ARRAY['status','published_by_identity_id','published_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','published_by_identity_id','published_at']) THEN RAISE EXCEPTION 'Only timing publication is permitted'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER attendance_timing_policy_immutable BEFORE UPDATE OR DELETE ON public.company_policy_versions FOR EACH ROW EXECUTE FUNCTION public.guard_attendance_timing_policy();
CREATE FUNCTION public.attendance_timing_policy_json(p public.company_policy_versions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',p.id,'version',p.policy_version,'basedOnVersion',p.based_on_version,'status',p.status,
 'effectiveFrom',to_char(p.effective_from,'YYYY-MM-DD'),'settings',p.settings,'reason',p.reason,'createdAt',p.created_at,'publishedAt',p.published_at)
$$;
CREATE FUNCTION public.read_attendance_timing_policies(p_actor uuid,p_mfa boolean,p_tenant uuid,p_limit integer,p_after uuid,p_asof date)
RETURNS TABLE(outcome text,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d date := coalesce(p_asof,(now() AT TIME ZONE 'Asia/Karachi')::date);
BEGIN
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 RETURN QUERY SELECT 'ok'::text,jsonb_build_object('tenantId',p_tenant,'asOf',to_char(d,'YYYY-MM-DD'),
 'latestPublishedVersion',(SELECT coalesce(max(policy_version),0) FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='attendance_timing' AND status='published'),
 'currentPolicy',(SELECT public.attendance_timing_policy_json(p) FROM public.company_policy_versions p WHERE tenant_id=p_tenant AND domain='attendance_timing' AND status='published' AND effective_from<=d ORDER BY effective_from DESC,policy_version DESC LIMIT 1),
 'items',coalesce((SELECT jsonb_agg(public.attendance_timing_policy_json(p) ORDER BY p.id) FROM (SELECT * FROM public.company_policy_versions WHERE tenant_id=p_tenant AND domain='attendance_timing' AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1) p),'[]'::jsonb));
END $$;
CREATE FUNCTION public.read_attendance_timing_policy(p_actor uuid,p_mfa boolean,p_tenant uuid,p_policy uuid)
RETURNS TABLE(outcome text,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 RETURN QUERY SELECT 'ok'::text,public.attendance_timing_policy_json(p) FROM public.company_policy_versions p WHERE tenant_id=p_tenant AND id=p_policy AND domain='attendance_timing';
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; END IF;
END $$;
CREATE FUNCTION public.mutate_attendance_timing_policy(p_actor uuid,p_mfa boolean,p_tenant uuid,p_request uuid,p_kind varchar,p_policy uuid,p_expected integer,p_effective date,p_settings jsonb,p_reason varchar,p_audit uuid,p_outbox uuid)
RETURNS TABLE(outcome text,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE payload jsonb; receipt public.attendance_timing_receipts%ROWTYPE; policy public.company_policy_versions%ROWTYPE;
 current_version integer; next_version integer; new_id uuid; result jsonb;
BEGIN
 PERFORM 1 FROM public.tenants WHERE id=p_tenant FOR SHARE;
 PERFORM 1 FROM public.identities WHERE id=p_actor FOR SHARE;
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
REVOKE ALL ON public.attendance_timing_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_attendance_timing_settings(jsonb),public.guard_attendance_timing_policy(),public.attendance_timing_policy_json(public.company_policy_versions),
 public.read_attendance_timing_policies(uuid,boolean,uuid,integer,uuid,date),public.read_attendance_timing_policy(uuid,boolean,uuid,uuid),
 public.mutate_attendance_timing_policy(uuid,boolean,uuid,uuid,varchar,uuid,integer,date,jsonb,varchar,uuid,uuid) FROM PUBLIC;
COMMIT;
