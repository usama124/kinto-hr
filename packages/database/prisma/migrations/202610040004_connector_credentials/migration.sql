BEGIN;
ALTER TABLE public.connector_enrollment_tokens ADD COLUMN generation_digest varchar(64) CHECK(generation_digest ~ '^[a-f0-9]{64}$'), ADD COLUMN redeemed_at timestamptz;
ALTER TABLE public.connector_enrollment_tokens ADD UNIQUE(tenant_id,id);
ALTER TABLE public.connector_enrollment_tokens DROP CONSTRAINT connector_enrollment_tokens_status_check;
ALTER TABLE public.connector_enrollment_tokens ADD CHECK(status IN ('issued','revoked','redeemed'));
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.connector_enrollment_tokens'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%revoked_at%' LOOP
 EXECUTE format('ALTER TABLE public.connector_enrollment_tokens DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE public.connector_enrollment_tokens ADD CHECK(
 (status='issued' AND version=1 AND revoked_at IS NULL AND redeemed_at IS NULL) OR
 (status='revoked' AND version=2 AND revoked_at IS NOT NULL AND redeemed_at IS NULL) OR
 (status='redeemed' AND version=2 AND revoked_at IS NULL AND redeemed_at IS NOT NULL AND generation_digest IS NOT NULL));
CREATE TABLE public.connector_credentials (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 device_id uuid NOT NULL,
 enrollment_id uuid NOT NULL UNIQUE,
 credential_digest varchar(64) NOT NULL UNIQUE CHECK(credential_digest ~ '^[a-f0-9]{64}$'),
 generation_digest varchar(64) NOT NULL CHECK(generation_digest ~ '^[a-f0-9]{64}$'),
 status varchar(20) NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 version integer NOT NULL DEFAULT 1 CHECK(version IN (1,2)),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 FOREIGN KEY(tenant_id,device_id) REFERENCES public.attendance_devices(tenant_id,id) ON DELETE RESTRICT,
 UNIQUE(tenant_id,enrollment_id),
 FOREIGN KEY(tenant_id,enrollment_id) REFERENCES public.connector_enrollment_tokens(tenant_id,id) ON DELETE RESTRICT,
 CHECK(expires_at=created_at+interval '720 hours'),
 CHECK((status='active' AND version=1 AND revoked_at IS NULL) OR (status='revoked' AND version=2 AND revoked_at IS NOT NULL))
);
ALTER TABLE public.connector_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_credentials FORCE ROW LEVEL SECURITY;
CREATE INDEX connector_capacity ON public.connector_credentials(tenant_id,expires_at) WHERE status='active';
CREATE FUNCTION public.connector_projection(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',id,'tenantId',tenant_id,'deviceId',device_id,'enrollmentId',enrollment_id,'version',version,
 'status',CASE WHEN status='active' AND expires_at<=clock_timestamp() THEN 'expired' ELSE status END,
 'createdAt',created_at,'expiresAt',expires_at,'revokedAt',revoked_at,'scope','heartbeat_only','attendanceIngestionAvailable',false)
 FROM public.connector_credentials WHERE id=p_id
$$;
CREATE OR REPLACE FUNCTION public.enrollment_projection(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('id',id,'deviceId',device_id,'expectedDeviceVersion',device_version,
 'allocationVersion',allocation_version,'version',version,
 'status',CASE WHEN status='issued' AND expires_at<=clock_timestamp() THEN 'expired' ELSE status END,
 'createdAt',created_at,'expiresAt',expires_at,'revokedAt',revoked_at) ||
 CASE WHEN status='redeemed' THEN jsonb_build_object('redeemedAt',redeemed_at,'connectorId',(SELECT id FROM public.connector_credentials WHERE enrollment_id=p_id)) ELSE '{}'::jsonb END
 FROM public.connector_enrollment_tokens WHERE id=p_id
$$;
CREATE FUNCTION public.issue_bound_connector_enrollment(
 p_actor uuid,p_mfa boolean,p_tenant uuid,p_request uuid,p_id uuid,p_device uuid,p_device_version integer,p_allocation_version integer,
 p_digest varchar,p_audit uuid,p_outbox uuid,p_generation varchar
) RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result record;
BEGIN
 IF p_generation IS NULL OR p_generation !~ '^[a-f0-9]{64}$' THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 SELECT * INTO result FROM public.issue_connector_enrollment(p_actor,p_mfa,p_tenant,p_request,p_id,p_device,p_device_version,p_allocation_version,p_digest,p_audit,p_outbox);
 IF result.outcome='created' THEN
 UPDATE public.connector_enrollment_tokens SET generation_digest=p_generation WHERE id=p_id;
 ELSIF result.outcome='replayed' AND NOT EXISTS(SELECT 1 FROM public.connector_enrollment_tokens WHERE id=(result.snapshot->>'id')::uuid AND generation_digest=p_generation) THEN
 RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN;
 END IF;
 RETURN QUERY SELECT result.outcome::text,result.snapshot::jsonb;
END $$;
CREATE FUNCTION public.redeem_connector_enrollment(p_token_digest varchar,p_generation varchar,p_id uuid,p_credential_digest varchar,p_audit uuid,p_token_outbox uuid,p_outbox uuid)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE token public.connector_enrollment_tokens%ROWTYPE; allocation public.attendance_allocations%ROWTYPE;
 device public.attendance_devices%ROWTYPE; stamp timestamptz; used integer;
BEGIN
 IF p_token_digest IS NULL OR p_token_digest !~ '^[a-f0-9]{64}$' OR p_generation IS NULL OR p_generation !~ '^[a-f0-9]{64}$' OR
 p_id IS NULL OR p_credential_digest IS NULL OR p_credential_digest !~ '^[a-f0-9]{64}$' THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 SELECT * INTO token FROM public.connector_enrollment_tokens WHERE token_digest=p_token_digest;
 IF NOT FOUND THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(token.tenant_id::text || ':attendance-allocation',0));
 SELECT * INTO token FROM public.connector_enrollment_tokens WHERE id=token.id FOR UPDATE;
 stamp:=clock_timestamp();
 IF token.status<>'issued' OR token.expires_at<=stamp OR token.generation_digest IS DISTINCT FROM p_generation OR
 public.tenant_organization_authorized(token.actor_id,true,token.tenant_id,true) IS NOT TRUE OR
 public.resolve_tenant_entitlements_at(token.tenant_id,stamp,NULL,NULL,NULL) IS NULL THEN
 RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 SELECT * INTO allocation FROM public.attendance_allocations WHERE tenant_id=token.tenant_id ORDER BY version DESC LIMIT 1;
 IF allocation.version IS NULL OR NOT allocation.enabled OR allocation.version<>token.allocation_version THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 SELECT * INTO device FROM public.attendance_devices WHERE tenant_id=token.tenant_id AND id=token.device_id FOR SHARE;
 IF NOT FOUND OR device.status<>'draft' OR device.version<>token.device_version OR
 NOT EXISTS(SELECT 1 FROM public.branches WHERE tenant_id=token.tenant_id AND id=device.branch_id AND status='active') THEN
 RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 PERFORM 1 FROM public.branches WHERE tenant_id=token.tenant_id AND id=device.branch_id AND status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM public.connector_credentials WHERE tenant_id=token.tenant_id AND device_id=token.device_id AND status='active' AND expires_at>stamp) THEN
 RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN; END IF;
 SELECT (SELECT count(*) FROM public.connector_credentials WHERE tenant_id=token.tenant_id AND status='active' AND expires_at>stamp)+
 (SELECT count(*) FROM public.connector_enrollment_tokens WHERE tenant_id=token.tenant_id AND status='issued' AND expires_at>stamp) INTO used;
 IF used>least(allocation.device_limit,allocation.connector_limit) THEN RETURN QUERY SELECT 'capacity_exceeded'::text,NULL::jsonb; RETURN; END IF;
 INSERT INTO public.connector_credentials(id,tenant_id,device_id,enrollment_id,credential_digest,generation_digest,created_at,expires_at)
 VALUES(p_id,token.tenant_id,token.device_id,token.id,p_credential_digest,p_generation,stamp,stamp+interval '720 hours');
 UPDATE public.connector_enrollment_tokens SET status='redeemed',version=2,redeemed_at=stamp WHERE id=token.id;
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id) VALUES(p_audit,token.tenant_id,token.actor_id,'connector.enrolled','initial_setup',p_id);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version) VALUES(p_token_outbox,token.tenant_id,'connector.enrollment_changed.v1',token.id,2),(p_outbox,token.tenant_id,'connector.credential_changed.v1',p_id,1);
 RETURN QUERY SELECT 'created'::text,public.connector_projection(p_id);
END $$;
CREATE FUNCTION public.authenticate_connector(p_digest varchar,p_generation varchar)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.connector_credentials%ROWTYPE; token public.connector_enrollment_tokens%ROWTYPE;
BEGIN
 SELECT * INTO c FROM public.connector_credentials WHERE credential_digest=p_digest AND generation_digest=p_generation AND status='active' AND expires_at>clock_timestamp();
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=c.tenant_id AND status='active') OR
 public.resolve_tenant_entitlements_at(c.tenant_id,clock_timestamp(),NULL,NULL,NULL) IS NULL OR
 NOT EXISTS(SELECT 1 FROM public.attendance_allocations WHERE tenant_id=c.tenant_id AND version=(SELECT max(version) FROM public.attendance_allocations WHERE tenant_id=c.tenant_id) AND enabled) THEN
 RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 SELECT * INTO token FROM public.connector_enrollment_tokens WHERE id=c.enrollment_id;
 IF token.status<>'redeemed' OR token.generation_digest IS DISTINCT FROM p_generation THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.attendance_devices d JOIN public.branches b ON b.tenant_id=d.tenant_id AND b.id=d.branch_id
 WHERE d.tenant_id=c.tenant_id AND d.id=c.device_id AND d.status='draft' AND d.version=token.device_version AND b.status='active') THEN
 RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 RETURN QUERY SELECT 'ok'::text,public.connector_projection(c.id);
END $$;
CREATE FUNCTION public.connector_security_record(p_actor uuid,p_mfa boolean,p_tenant uuid,p_id uuid,p_kind varchar)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_kind='enrollment' THEN
 RETURN QUERY SELECT 'ok'::text,jsonb_build_object('id',id,'digest',token_digest,'generation',generation_digest) FROM public.connector_enrollment_tokens WHERE tenant_id=p_tenant AND id=p_id;
 ELSIF p_kind='credential' THEN
 RETURN QUERY SELECT 'ok'::text,jsonb_build_object('id',id,'digest',credential_digest,'generation',generation_digest) FROM public.connector_credentials WHERE tenant_id=p_tenant AND id=p_id;
 ELSE RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; END IF;
END $$;
CREATE FUNCTION public.revoke_connector_credential(p_actor uuid,p_mfa boolean,p_tenant uuid,p_id uuid,p_expected integer,p_audit uuid,p_outbox uuid)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.connector_credentials%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_expected IS DISTINCT FROM 1 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':attendance-allocation',0));
 SELECT * INTO c FROM public.connector_credentials WHERE tenant_id=p_tenant AND id=p_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
 IF c.status='revoked' THEN RETURN QUERY SELECT 'replayed'::text,public.connector_projection(p_id); RETURN; END IF;
 UPDATE public.connector_credentials SET status='revoked',version=2,revoked_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id) VALUES(p_audit,p_tenant,p_actor,'connector.revoked','revoke_connector',p_id);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version) VALUES(p_outbox,p_tenant,'connector.credential_changed.v1',p_id,2);
 RETURN QUERY SELECT 'updated'::text,public.connector_projection(p_id);
END $$;
CREATE FUNCTION public.list_connector_credentials(p_actor uuid,p_mfa boolean,p_tenant uuid,p_limit integer,p_after uuid)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,false) IS NOT TRUE THEN RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 RETURN QUERY SELECT 'ok'::text,coalesce(jsonb_agg(public.connector_projection(id) ORDER BY id),'[]'::jsonb)
 FROM (SELECT id FROM public.connector_credentials WHERE tenant_id=p_tenant AND (p_after IS NULL OR id>p_after) ORDER BY id LIMIT p_limit+1) q;
END $$;
REVOKE ALL ON public.connector_credentials FROM PUBLIC;
REVOKE ALL ON FUNCTION public.connector_projection(uuid),public.issue_bound_connector_enrollment(uuid,boolean,uuid,uuid,uuid,uuid,integer,integer,varchar,uuid,uuid,varchar),
 public.redeem_connector_enrollment(varchar,varchar,uuid,varchar,uuid,uuid,uuid),public.authenticate_connector(varchar,varchar),
 public.connector_security_record(uuid,boolean,uuid,uuid,varchar),public.revoke_connector_credential(uuid,boolean,uuid,uuid,integer,uuid,uuid),
 public.list_connector_credentials(uuid,boolean,uuid,integer,uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.issue_connector_enrollment(
 p_actor uuid,p_mfa boolean,p_tenant uuid,p_request uuid,p_id uuid,p_device uuid,p_device_version integer,p_allocation_version integer,
 p_digest varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old public.connector_enrollment_tokens%ROWTYPE; allocation public.attendance_allocations%ROWTYPE;
 device public.attendance_devices%ROWTYPE; issued_at timestamptz; used integer;
BEGIN
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 IF p_request IS NULL OR p_id IS NULL OR p_device IS NULL OR p_device_version IS NULL OR p_device_version<1 OR
 p_allocation_version IS NULL OR p_allocation_version<1 OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':attendance-allocation',0));
 IF public.resolve_tenant_entitlements_at(p_tenant,clock_timestamp(),NULL,NULL,NULL) IS NULL THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN;
 END IF;
 SELECT * INTO old FROM public.connector_enrollment_tokens WHERE tenant_id=p_tenant AND actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF old.device_id<>p_device OR old.device_version<>p_device_version OR old.allocation_version<>p_allocation_version THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN;
  END IF;
  -- Never return the digest or mint/extend/restore a token on retry.
  RETURN QUERY SELECT 'replayed'::text,public.enrollment_projection(old.id); RETURN;
 END IF;
 SELECT * INTO allocation FROM public.attendance_allocations WHERE tenant_id=p_tenant ORDER BY version DESC LIMIT 1;
 IF allocation.version IS NULL OR NOT allocation.enabled THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF allocation.version<>p_allocation_version THEN RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN; END IF;
 SELECT * INTO device FROM public.attendance_devices WHERE tenant_id=p_tenant AND id=p_device FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
 IF device.status<>'draft' THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF device.version<>p_device_version THEN RETURN QUERY SELECT 'stale'::text,NULL::jsonb; RETURN; END IF;
 PERFORM 1 FROM public.branches WHERE tenant_id=p_tenant AND id=device.branch_id AND status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 issued_at:=clock_timestamp();
 IF EXISTS(SELECT 1 FROM public.connector_enrollment_tokens WHERE tenant_id=p_tenant AND device_id=p_device AND status='issued' AND expires_at>issued_at) OR EXISTS(SELECT 1 FROM public.connector_credentials WHERE tenant_id=p_tenant AND device_id=p_device AND status='active' AND expires_at>issued_at) THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::jsonb; RETURN;
 END IF;
 SELECT (SELECT count(*) FROM public.connector_enrollment_tokens WHERE tenant_id=p_tenant AND status='issued' AND expires_at>issued_at)+(SELECT count(*) FROM public.connector_credentials WHERE tenant_id=p_tenant AND status='active' AND expires_at>issued_at) INTO used;
 -- One reserved connector and one distinct device per token in this initial boundary.
 IF used>=allocation.device_limit OR used>=allocation.connector_limit THEN
  RETURN QUERY SELECT 'capacity_exceeded'::text,NULL::jsonb; RETURN;
 END IF;
 INSERT INTO public.connector_enrollment_tokens(id,tenant_id,device_id,actor_id,request_id,device_version,allocation_version,token_digest,created_at,expires_at)
 VALUES(p_id,p_tenant,p_device,p_actor,p_request,p_device_version,p_allocation_version,p_digest,issued_at,issued_at+interval '15 minutes');
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id) VALUES(p_audit,p_tenant,p_actor,'connector.enrollment_issued','initial_setup',p_id);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version) VALUES(p_outbox,p_tenant,'connector.enrollment_changed.v1',p_id,1);
 RETURN QUERY SELECT 'created'::text,public.enrollment_projection(p_id);
END $$;
CREATE OR REPLACE FUNCTION public.change_attendance_allocation(
 p_actor uuid,p_mfa boolean,p_tenant uuid,p_request uuid,p_record uuid,p_expected integer,
 p_enabled boolean,p_devices integer,p_connectors integer,p_reason varchar,p_audit uuid,p_platform_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome text,record_id uuid,record_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE existing public.attendance_allocations%ROWTYPE; current_allocation public.attendance_allocations%ROWTYPE;
BEGIN
 IF public.check_platform_operator_access(p_actor,p_mfa) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=p_tenant AND status='active') OR
   public.resolve_tenant_entitlements_at(p_tenant,now(),NULL,NULL,NULL) IS NULL THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 IF p_request IS NULL OR p_record IS NULL OR p_expected IS NULL OR p_expected NOT BETWEEN 0 AND 2147483646 OR
  p_enabled IS NULL OR p_devices IS NULL OR p_connectors IS NULL OR p_reason IS NULL OR
  p_devices NOT BETWEEN 0 AND 1000 OR p_connectors NOT BETWEEN 0 AND 1000 OR
  NOT ((p_enabled AND p_devices>0 AND p_connectors>0 AND p_reason=CASE WHEN p_expected=0 THEN 'initial_setup' ELSE 'allocation_change' END) OR
    (NOT p_enabled AND p_devices=0 AND p_connectors=0 AND p_expected>0 AND p_reason='disable_attendance')) THEN
  RETURN QUERY SELECT 'invalid_state'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 -- Future reservation/activation paths must share this lock and recheck effective capacity.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':attendance-allocation',0));
 SELECT * INTO existing FROM public.attendance_allocations WHERE tenant_id=p_tenant AND actor_id=p_actor AND request_id=p_request;
 IF FOUND THEN
  IF existing.expected_version<>p_expected OR existing.enabled<>p_enabled OR existing.device_limit<>p_devices OR
   existing.connector_limit<>p_connectors OR existing.reason<>p_reason THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer; RETURN;
  END IF;
  RETURN QUERY SELECT 'replayed'::text,existing.id,existing.version; RETURN;
 END IF;
 SELECT * INTO current_allocation FROM public.attendance_allocations WHERE tenant_id=p_tenant ORDER BY version DESC LIMIT 1;
 IF coalesce(current_allocation.version,0)<>p_expected THEN
  RETURN QUERY SELECT 'stale'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 IF current_allocation.version IS NOT NULL AND current_allocation.enabled=p_enabled AND current_allocation.device_limit=p_devices AND current_allocation.connector_limit=p_connectors THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 -- Reserve/issue and allocation changes share a tenant lock. Expired/revoked tokens no longer consume capacity.
 IF (SELECT count(*) FROM public.connector_enrollment_tokens WHERE tenant_id=p_tenant AND status='issued' AND expires_at>clock_timestamp())+(SELECT count(*) FROM public.connector_credentials WHERE tenant_id=p_tenant AND status='active' AND expires_at>clock_timestamp())>least(p_devices,p_connectors) THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::uuid,NULL::integer; RETURN;
 END IF;
 INSERT INTO public.attendance_allocations(id,tenant_id,actor_id,request_id,expected_version,version,enabled,device_limit,connector_limit,reason)
  VALUES(p_record,p_tenant,p_actor,p_request,p_expected,p_expected+1,p_enabled,p_devices,p_connectors,p_reason);
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
  VALUES(p_audit,p_tenant,p_actor,'attendance.allocation_changed',p_reason,p_record);
 INSERT INTO public.platform_audit_events(id,actor_id,action,resource_id)
  VALUES(p_platform_audit,p_actor,'attendance.allocation_changed',p_tenant);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
  VALUES(p_outbox,p_tenant,'attendance.allocation_changed.v1',p_tenant,p_expected+1);
 RETURN QUERY SELECT 'created'::text,p_record,p_expected+1;
END $$;
CREATE OR REPLACE FUNCTION public.revoke_connector_enrollment(p_actor uuid,p_mfa boolean,p_tenant uuid,p_id uuid,p_expected integer,p_audit uuid,p_outbox uuid)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old public.connector_enrollment_tokens%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 IF p_id IS NULL OR p_expected IS DISTINCT FROM 1 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':attendance-allocation',0));
 SELECT * INTO old FROM public.connector_enrollment_tokens WHERE tenant_id=p_tenant AND id=p_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
 IF old.generation_digest IS NOT NULL THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF old.status='revoked' THEN RETURN QUERY SELECT 'replayed'::text,public.enrollment_projection(p_id); RETURN; END IF;
 UPDATE public.connector_enrollment_tokens SET status='revoked',version=2,revoked_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id) VALUES(p_audit,p_tenant,p_actor,'connector.enrollment_revoked','revoke_enrollment',p_id);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version) VALUES(p_outbox,p_tenant,'connector.enrollment_changed.v1',p_id,2);
 RETURN QUERY SELECT 'updated'::text,public.enrollment_projection(p_id);
END $$;
CREATE FUNCTION public.revoke_bound_connector_enrollment(p_actor uuid,p_mfa boolean,p_tenant uuid,p_id uuid,p_expected integer,p_audit uuid,p_outbox uuid)
RETURNS TABLE(outcome text,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old public.connector_enrollment_tokens%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.memberships WHERE tenant_id=p_tenant AND identity_id=p_actor FOR SHARE;
 IF public.tenant_organization_authorized(p_actor,p_mfa,p_tenant,true) IS NOT TRUE THEN
  RETURN QUERY SELECT 'forbidden'::text,NULL::jsonb; RETURN;
 END IF;
 IF p_id IS NULL OR p_expected IS DISTINCT FROM 1 THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':attendance-allocation',0));
 SELECT * INTO old FROM public.connector_enrollment_tokens WHERE tenant_id=p_tenant AND id=p_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb; RETURN; END IF;
 IF old.status='redeemed' THEN RETURN QUERY SELECT 'invalid_state'::text,NULL::jsonb; RETURN; END IF;
 IF old.status='revoked' THEN RETURN QUERY SELECT 'replayed'::text,public.enrollment_projection(p_id); RETURN; END IF;
 UPDATE public.connector_enrollment_tokens SET status='revoked',version=2,revoked_at=clock_timestamp() WHERE id=p_id;
 INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id) VALUES(p_audit,p_tenant,p_actor,'connector.enrollment_revoked','revoke_enrollment',p_id);
 INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version) VALUES(p_outbox,p_tenant,'connector.enrollment_changed.v1',p_id,2);
 RETURN QUERY SELECT 'updated'::text,public.enrollment_projection(p_id);
END $$;
REVOKE ALL ON FUNCTION public.revoke_bound_connector_enrollment(uuid,boolean,uuid,uuid,integer,uuid,uuid) FROM PUBLIC;
COMMIT;
