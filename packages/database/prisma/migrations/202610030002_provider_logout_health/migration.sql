-- Private aggregate probe. Never claims work or exposes receipt identifiers.
CREATE FUNCTION public.provider_logout_health(p_namespace text)
RETURNS TABLE(pending bigint,unattempted bigint,oldest_pending_seconds double precision,last_attempt_seconds double precision)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT count(*),count(*) FILTER (WHERE last_attempted_at IS NULL),
    coalesce(greatest(0,extract(epoch FROM (statement_timestamp()-min(accepted_at))))::double precision,0),
    CASE WHEN max(last_attempted_at) IS NULL THEN NULL
      ELSE greatest(0,extract(epoch FROM (statement_timestamp()-max(last_attempted_at))))::double precision END
  FROM public.auth_provider_logout_events
  WHERE namespace=p_namespace AND completed_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.provider_logout_health(text) FROM PUBLIC;
