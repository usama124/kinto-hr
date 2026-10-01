BEGIN;
CREATE FUNCTION public.list_platform_companies(
  p_actor uuid, p_mfa boolean, p_limit integer, p_after uuid, p_search varchar
) RETURNS TABLE(outcome varchar, payload jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE items jsonb;
BEGIN
  IF public.check_platform_operator_access(p_actor,p_mfa) IS NOT TRUE THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100
     OR (p_search IS NOT NULL AND (length(btrim(p_search)) < 1 OR length(p_search) > 160)) THEN
    RETURN QUERY SELECT 'invalid'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT coalesce(jsonb_agg(q.item ORDER BY q.id),'[]'::jsonb) INTO items FROM (
    SELECT t.id, jsonb_build_object(
      'id',t.id,'name',t.name,'status',t.status,'createdAt',t.created_at,
      'ownerSetupStatus',r.status,
      'baseSubscription', CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object(
        'plan',p.code,'planVersion',p.plan_version,
        'billingMode',s.billing_mode,'employeeLimit',s.employee_limit
      ) END
    ) AS item
    FROM public.tenants t
    LEFT JOIN public.company_provisioning_requests r ON r.tenant_id=t.id
    LEFT JOIN public.tenant_subscriptions s ON s.tenant_id=t.id AND s.status='active' AND s.effective_from<=now()
    LEFT JOIN public.plan_versions p ON p.id=s.plan_version_id
    WHERE (p_after IS NULL OR t.id>p_after)
      AND (p_search IS NULL OR strpos(lower(t.name),lower(btrim(p_search)))>0)
    ORDER BY t.id LIMIT p_limit+1
  ) q;
  RETURN QUERY SELECT 'ok'::varchar,jsonb_build_object(
    'companies',(SELECT coalesce(jsonb_agg(e.value ORDER BY e.ordinality),'[]'::jsonb)
      FROM jsonb_array_elements(items) WITH ORDINALITY e WHERE e.ordinality<=p_limit),
    'nextCursor', CASE WHEN jsonb_array_length(items)>p_limit THEN items->(p_limit-1)->>'id' ELSE NULL END
  );
END $$;
REVOKE ALL ON FUNCTION public.list_platform_companies(uuid,boolean,integer,uuid,varchar) FROM PUBLIC;
COMMIT;
