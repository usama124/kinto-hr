BEGIN;
CREATE FUNCTION public.valid_leave_policy_settings(s jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text; n numeric; y jsonb; m integer; d integer;
 keys text[] := ARRAY['scope','timeZone','code','name','pay','grantMode','annualQuotaDays','monthlyQuotaDays','leaveYearStart','nonWorkingDays'];
BEGIN
 IF s IS NULL OR jsonb_typeof(s)<>'object' OR NOT(s ?& keys) OR s-keys<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['scope','timeZone','code','name','pay','grantMode','nonWorkingDays'] LOOP
  IF jsonb_typeof(s->k)<>'string' THEN RETURN false; END IF;
 END LOOP;
 IF s->>'scope'<>'company' OR s->>'timeZone'<>'Asia/Karachi' OR s->>'code' !~ '^[A-Z][A-Z0-9_-]{0,31}$'
 OR length(s->>'name') NOT BETWEEN 1 AND 120 OR btrim(s->>'name')<>s->>'name'
 OR s->>'pay' NOT IN ('paid','unpaid') OR s->>'grantMode'<>'annual_upfront' OR s->>'nonWorkingDays' NOT IN ('exclude','include') THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['annualQuotaDays','monthlyQuotaDays'] LOOP
  IF jsonb_typeof(s->k)<>'number' THEN RETURN false; END IF;
  n := (s->>k)::numeric;
  IF n<0 OR n>(CASE WHEN k='annualQuotaDays' THEN 366 ELSE 31 END) OR n*2<>trunc(n*2) THEN RETURN false; END IF;
 END LOOP;
 y:=s->'leaveYearStart';
 IF jsonb_typeof(y)<>'object' OR NOT(y ?& ARRAY['month','day']) OR y-ARRAY['month','day']<>'{}'::jsonb
 OR jsonb_typeof(y->'month')<>'number' OR jsonb_typeof(y->'day')<>'number' THEN RETURN false; END IF;
 IF (y->>'month')::numeric<>trunc((y->>'month')::numeric) OR (y->>'day')::numeric<>trunc((y->>'day')::numeric) THEN RETURN false; END IF;
 m:=(y->>'month')::integer; d:=(y->>'day')::integer;
 PERFORM make_date(2001,m,d);
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE TABLE public.leave_types (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 code varchar(32) NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_-]{0,31}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE TABLE public.leave_policy_versions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 leave_type_id uuid NOT NULL,
 policy_version integer NOT NULL CHECK(policy_version>0),
 based_on_version integer NOT NULL CHECK(based_on_version>=0 AND based_on_version<policy_version),
 status varchar(20) NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 effective_from date NOT NULL CHECK(effective_from BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 settings jsonb NOT NULL CHECK(public.valid_leave_policy_settings(settings)),
 reason varchar(240) NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 240),
 created_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
 published_by_identity_id uuid REFERENCES public.identities(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
 CHECK((status='draft' AND published_by_identity_id IS NULL AND published_at IS NULL) OR (status='published' AND published_by_identity_id IS NOT NULL AND published_at IS NOT NULL)),
 FOREIGN KEY(tenant_id,leave_type_id) REFERENCES public.leave_types(tenant_id,id) ON DELETE RESTRICT,
 UNIQUE(tenant_id,leave_type_id,id), UNIQUE(tenant_id,leave_type_id,policy_version)
);
CREATE UNIQUE INDEX leave_policy_effective_unique ON public.leave_policy_versions(tenant_id,leave_type_id,effective_from) WHERE status='published';
CREATE INDEX leave_policy_history ON public.leave_policy_versions(tenant_id,leave_type_id,status,effective_from);
CREATE TABLE public.leave_policy_receipts (
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL, input jsonb NOT NULL, leave_type_id uuid NOT NULL, policy_id uuid NOT NULL, snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,request_id),
 FOREIGN KEY(tenant_id,leave_type_id,policy_id) REFERENCES public.leave_policy_versions(tenant_id,leave_type_id,id) ON DELETE RESTRICT
);
ALTER TABLE public.leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_types FORCE ROW LEVEL SECURITY;
ALTER TABLE public.leave_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.leave_policy_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_policy_receipts FORCE ROW LEVEL SECURITY;
CREATE FUNCTION public.guard_leave_policy_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (SELECT rolsuper FROM pg_roles WHERE rolname=session_user) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='leave_types' THEN RAISE EXCEPTION 'Leave type history is immutable'; END IF;
 IF TG_OP='DELETE' OR OLD.status='published' THEN RAISE EXCEPTION 'Leave policy history is immutable'; END IF;
 IF NEW.status<>'published' OR (to_jsonb(NEW)-ARRAY['status','published_by_identity_id','published_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','published_by_identity_id','published_at']) THEN RAISE EXCEPTION 'Only leave publication is permitted'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER leave_type_immutable BEFORE UPDATE OR DELETE ON public.leave_types FOR EACH ROW EXECUTE FUNCTION public.guard_leave_policy_history();
CREATE TRIGGER leave_policy_immutable BEFORE UPDATE OR DELETE ON public.leave_policy_versions FOR EACH ROW EXECUTE FUNCTION public.guard_leave_policy_history();
CREATE FUNCTION public.leave_policy_json(p public.leave_policy_versions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',p.id,'tenantId',p.tenant_id,'leaveTypeId',p.leave_type_id,'version',p.policy_version,'basedOnVersion',p.based_on_version,'status',p.status,
 'effectiveFrom',to_char(p.effective_from,'YYYY-MM-DD'),'effectiveUntil',CASE WHEN p.status='published' THEN (SELECT to_char(min(effective_from),'YYYY-MM-DD') FROM public.leave_policy_versions WHERE tenant_id=p.tenant_id AND leave_type_id=p.leave_type_id AND status='published' AND effective_from>p.effective_from) ELSE NULL END,
 'settings',p.settings,'reason',p.reason,'createdAt',p.created_at,'publishedAt',p.published_at)
$$;
CREATE FUNCTION public.read_company_leave_policies(p_actor uuid,p_mfa boolean,p_tenant uuid,p_type uuid,p_limit integer,p_after uuid,p_asof date)
RETURNS TABLE(outcome text,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE d date:=coalesce(p_asof,(now() AT TIME ZONE 'Asia/Karachi')::date); t public.leave_types%ROWTYPE;
BEGIN
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR d NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF p_type IS NULL THEN
  RETURN QUERY SELECT 'ok'::text,jsonb_build_object('tenantId',p_tenant,'items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'code',v.code,'createdAt',v.created_at) ORDER BY v.id) FROM (SELECT * FROM public.leave_types WHERE tenant_id=p_tenant AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1) v),'[]'::jsonb)); RETURN;
 END IF;
 SELECT * INTO t FROM public.leave_types WHERE tenant_id=p_tenant AND id=p_type;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
 RETURN QUERY SELECT 'ok'::text,jsonb_build_object('tenantId',p_tenant,'leaveType',jsonb_build_object('id',t.id,'code',t.code,'createdAt',t.created_at),'asOf',to_char(d,'YYYY-MM-DD'),
 'latestPublishedVersion',(SELECT coalesce(max(policy_version),0) FROM public.leave_policy_versions WHERE tenant_id=p_tenant AND leave_type_id=p_type AND status='published'),
 'currentPolicy',(SELECT public.leave_policy_json(p) FROM public.leave_policy_versions p WHERE tenant_id=p_tenant AND leave_type_id=p_type AND status='published' AND effective_from<=d ORDER BY effective_from DESC LIMIT 1),
 'items',coalesce((SELECT jsonb_agg(public.leave_policy_json(p) ORDER BY p.id) FROM (SELECT * FROM public.leave_policy_versions WHERE tenant_id=p_tenant AND leave_type_id=p_type AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1) p),'[]'::jsonb));
END $$;
CREATE FUNCTION public.mutate_company_leave_policy(p_actor uuid,p_mfa boolean,p_tenant uuid,p_request uuid,p_kind varchar,p_type uuid,p_policy uuid,p_expected integer,p_effective date,p_settings jsonb,p_reason varchar,p_audit uuid,p_outbox uuid)
RETURNS TABLE(outcome text,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE payload jsonb; receipt public.leave_policy_receipts%ROWTYPE; policy public.leave_policy_versions%ROWTYPE; t public.leave_types%ROWTYPE;
 current_version integer; next_version integer; type_id uuid; policy_id uuid; result jsonb; prior_settings jsonb;
BEGIN
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_request IS NULL OR p_expected IS NULL OR p_expected<0 OR (p_kind<>'publish' AND p_expected>2147483646) OR p_kind IS NULL OR p_kind NOT IN ('create_type','draft','publish') OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 OR p_audit IS NULL OR p_outbox IS NULL THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF (p_kind='create_type' AND (p_type IS NOT NULL OR p_expected<>0)) OR (p_kind<>'create_type' AND p_type IS NULL)
 OR (p_kind<>'publish' AND (p_policy IS NOT NULL OR p_effective IS NULL OR p_effective NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' OR public.valid_leave_policy_settings(p_settings) IS NOT TRUE))
 OR (p_kind='publish' AND (p_policy IS NULL OR p_expected<1 OR p_effective IS NOT NULL OR p_settings IS NOT NULL)) THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 payload:=jsonb_build_object('kind',p_kind,'leaveTypeId',p_type,'policyId',p_policy,'expectedVersion',p_expected,'effectiveFrom',p_effective,'settings',p_settings,'reason',btrim(p_reason));
 -- One company lock serializes actor-key receipts across all leave types.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':leave_policies',0));
 SELECT * INTO receipt FROM public.leave_policy_receipts WHERE tenant_id=p_tenant AND actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF receipt.input IS DISTINCT FROM payload THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  RETURN QUERY SELECT 'ok'::text,receipt.snapshot||jsonb_build_object('replayed',true); RETURN;
 END IF;
 type_id:=p_type;
 IF p_kind='create_type' THEN
  IF EXISTS(SELECT 1 FROM public.leave_types WHERE tenant_id=p_tenant AND code=p_settings->>'code') THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  current_version:=0; next_version:=1; type_id:=gen_random_uuid();
 ELSE
  SELECT * INTO t FROM public.leave_types WHERE tenant_id=p_tenant AND id=p_type;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
  SELECT coalesce(max(policy_version),0) INTO current_version FROM public.leave_policy_versions WHERE tenant_id=p_tenant AND leave_type_id=p_type AND status='published';
 END IF;
 IF p_kind<>'publish' THEN
  IF p_expected<>current_version THEN RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN; END IF;
  IF p_effective<(now() AT TIME ZONE 'Asia/Karachi')::date OR EXISTS(SELECT 1 FROM public.leave_policy_versions WHERE tenant_id=p_tenant AND leave_type_id=type_id AND status='published' AND effective_from>=p_effective) OR (p_kind='draft' AND p_settings->>'code'<>t.code) THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  SELECT settings INTO prior_settings FROM public.leave_policy_versions WHERE tenant_id=p_tenant AND leave_type_id=type_id AND status='published' ORDER BY policy_version DESC LIMIT 1;
  IF prior_settings IS NOT NULL AND prior_settings->'leaveYearStart' IS DISTINCT FROM p_settings->'leaveYearStart' THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  IF p_kind='create_type' THEN INSERT INTO public.leave_types(id,tenant_id,code) VALUES(type_id,p_tenant,p_settings->>'code'); END IF;
  SELECT coalesce(max(policy_version),0) INTO next_version FROM public.leave_policy_versions WHERE tenant_id=p_tenant AND leave_type_id=type_id;
  IF next_version=2147483647 THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  next_version:=next_version+1;
  policy_id:=gen_random_uuid();
  INSERT INTO public.leave_policy_versions(id,tenant_id,leave_type_id,policy_version,based_on_version,effective_from,settings,reason,created_by_identity_id) VALUES(policy_id,p_tenant,type_id,next_version,current_version,p_effective,p_settings,btrim(p_reason),p_actor);
 ELSE
  SELECT * INTO policy FROM public.leave_policy_versions WHERE tenant_id=p_tenant AND leave_type_id=p_type AND id=p_policy FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
  IF policy.status<>'draft' OR policy.policy_version<>p_expected OR policy.based_on_version<>current_version THEN RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN; END IF;
  IF policy.effective_from<(now() AT TIME ZONE 'Asia/Karachi')::date OR policy.settings->>'code'<>t.code OR EXISTS(SELECT 1 FROM public.leave_policy_versions WHERE tenant_id=p_tenant AND leave_type_id=p_type AND status='published' AND effective_from>=policy.effective_from) THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  SELECT settings INTO prior_settings FROM public.leave_policy_versions WHERE tenant_id=p_tenant AND leave_type_id=p_type AND status='published' ORDER BY policy_version DESC LIMIT 1;
  IF prior_settings IS NOT NULL AND prior_settings->'leaveYearStart' IS DISTINCT FROM policy.settings->'leaveYearStart' THEN RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
  policy_id:=policy.id; next_version:=policy.policy_version;
  UPDATE public.leave_policy_versions SET status='published',published_by_identity_id=p_actor,published_at=now() WHERE tenant_id=p_tenant AND id=policy_id;
 END IF;
 result:=jsonb_build_object('leaveTypeId',type_id,'id',policy_id,'version',next_version,'replayed',false);
 INSERT INTO public.leave_policy_receipts(tenant_id,actor_id,request_id,input,leave_type_id,policy_id,snapshot) VALUES(p_tenant,p_actor,p_request,payload,type_id,policy_id,result);
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id) VALUES(p_audit,p_tenant,p_actor,'leave_policy.'||p_kind,btrim(p_reason),policy_id);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version) VALUES(p_outbox,p_tenant,'leave_policy.'||p_kind||'.v1',policy_id,next_version);
 RETURN QUERY SELECT 'ok'::text,result;
END $$;
REVOKE ALL ON public.leave_types,public.leave_policy_versions,public.leave_policy_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_leave_policy_settings(jsonb),public.guard_leave_policy_history(),public.leave_policy_json(public.leave_policy_versions),public.read_company_leave_policies(uuid,boolean,uuid,uuid,integer,uuid,date),public.mutate_company_leave_policy(uuid,boolean,uuid,uuid,varchar,uuid,uuid,integer,date,jsonb,varchar,uuid,uuid) FROM PUBLIC;
COMMIT;
