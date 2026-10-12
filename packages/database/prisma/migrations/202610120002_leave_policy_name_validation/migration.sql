BEGIN;
-- Match the shared contract trim semantics for direct constrained SQL calls.
CREATE OR REPLACE FUNCTION public.valid_leave_policy_settings(s jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE k text; n numeric; y jsonb; m integer; d integer;
 trim_chars text := E' \t\n\r\f' || chr(11) || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
 keys text[] := ARRAY['scope','timeZone','code','name','pay','grantMode','annualQuotaDays','monthlyQuotaDays','leaveYearStart','nonWorkingDays'];
BEGIN
 IF s IS NULL OR jsonb_typeof(s)<>'object' OR NOT(s ?& keys) OR s-keys<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['scope','timeZone','code','name','pay','grantMode','nonWorkingDays'] LOOP
  IF jsonb_typeof(s->k)<>'string' THEN RETURN false; END IF;
 END LOOP;
 IF s->>'scope'<>'company' OR s->>'timeZone'<>'Asia/Karachi' OR s->>'code' !~ '^[A-Z][A-Z0-9_-]{0,31}$'
 OR length(s->>'name') NOT BETWEEN 1 AND 120 OR btrim(s->>'name',trim_chars)<>s->>'name'
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
COMMIT;
