-- Trusted API process accepts only verified OIDC Logout Tokens. No raw tokens,
-- subjects, session IDs, credentials or company permissions are persisted.
CREATE TABLE public.auth_provider_logout_events (
  namespace char(64) NOT NULL CHECK (namespace ~ '^[a-f0-9]{64}$'),
  event_key char(64) NOT NULL CHECK (event_key ~ '^[a-f0-9]{64}$'),
  target_kind varchar(10) NOT NULL CHECK (target_kind IN ('subject','session')),
  target_hash char(64) NOT NULL CHECK (target_hash ~ '^[a-f0-9]{64}$'),
  issued_at bigint NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_attempted_at timestamptz,
  PRIMARY KEY (namespace,event_key)
);
CREATE INDEX auth_provider_logout_pending_idx ON public.auth_provider_logout_events(namespace,last_attempted_at,accepted_at,event_key) WHERE completed_at IS NULL;
CREATE INDEX auth_provider_logout_target_idx ON public.auth_provider_logout_events(namespace,target_kind,target_hash,issued_at);
ALTER TABLE public.auth_provider_logout_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_provider_logout_events FORCE ROW LEVEL SECURITY;

CREATE FUNCTION public.accept_provider_logout(p_namespace text,p_event_key text,p_kind text,p_target text,p_issued bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v public.auth_provider_logout_events%ROWTYPE;
BEGIN
  INSERT INTO public.auth_provider_logout_events(namespace,event_key,target_kind,target_hash,issued_at)
    VALUES(p_namespace,p_event_key,p_kind,p_target,p_issued) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT v FROM public.auth_provider_logout_events WHERE namespace=p_namespace AND event_key=p_event_key;
  IF v.target_kind IS DISTINCT FROM p_kind OR v.target_hash IS DISTINCT FROM p_target OR v.issued_at IS DISTINCT FROM p_issued THEN
    RAISE EXCEPTION 'PROVIDER_LOGOUT_CONFLICT';
  END IF;
  RETURN v.completed_at IS NOT NULL;
END $$;
CREATE FUNCTION public.pending_provider_logouts(p_namespace text)
RETURNS TABLE(event_key text,target_kind text,target_hash text,issued_at bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH candidates AS (
    SELECT namespace,event_key FROM public.auth_provider_logout_events
    WHERE namespace=p_namespace AND completed_at IS NULL
    ORDER BY last_attempted_at NULLS FIRST,accepted_at,event_key LIMIT 25 FOR UPDATE SKIP LOCKED
  ), attempted AS (
    UPDATE public.auth_provider_logout_events e SET last_attempted_at=clock_timestamp()
    FROM candidates c WHERE e.namespace=c.namespace AND e.event_key=c.event_key
    RETURNING e.event_key,e.target_kind,e.target_hash,e.issued_at
  ) SELECT event_key::text,target_kind::text,target_hash::text,issued_at FROM attempted
$$;
CREATE FUNCTION public.complete_provider_logout(p_namespace text,p_event_key text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  UPDATE public.auth_provider_logout_events SET completed_at=coalesce(completed_at,now()) WHERE namespace=p_namespace AND event_key=p_event_key
$$;
CREATE FUNCTION public.provider_session_revoked(p_namespace text,p_subject_hash text,p_session_hash text,p_auth_time bigint)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (SELECT 1 FROM public.auth_provider_logout_events WHERE namespace=p_namespace AND issued_at>=p_auth_time
    AND ((target_kind='subject' AND target_hash=p_subject_hash) OR (target_kind='session' AND target_hash=p_session_hash)))
$$;
REVOKE ALL ON public.auth_provider_logout_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_provider_logout(text,text,text,text,bigint),public.pending_provider_logouts(text),public.complete_provider_logout(text,text),public.provider_session_revoked(text,text,text,bigint) FROM PUBLIC;
