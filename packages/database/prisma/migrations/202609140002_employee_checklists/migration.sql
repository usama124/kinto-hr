BEGIN;

-- Some early local installations applied the employee-period migration before
-- its composite relation key was present. The index is redundant on current
-- installations and makes that supported upgrade path safe.
CREATE UNIQUE INDEX IF NOT EXISTS employment_periods_tenant_id_id_employee_id_key
  ON public.employment_periods(tenant_id,id,employee_id);

CREATE TABLE public.checklist_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL,
  employment_period_id uuid NOT NULL,
  lifecycle varchar(20) NOT NULL CHECK (lifecycle IN ('onboarding','offboarding')),
  task_code varchar(50) NOT NULL CHECK (task_code ~ '^[A-Z][A-Z0-9_]*$'),
  title varchar(160) NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  assignee_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  due_date date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  completed_at timestamptz,
  completed_by_identity_id uuid REFERENCES public.identities(id) ON DELETE RESTRICT,
  created_by_identity_id uuid NOT NULL REFERENCES public.identities(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,employment_period_id,task_code),
  FOREIGN KEY (tenant_id,employment_period_id,employee_id) REFERENCES public.employment_periods(tenant_id,id,employee_id) ON DELETE RESTRICT,
  CHECK ((status='completed')=(completed_at IS NOT NULL)),
  CHECK ((completed_at IS NULL)=(completed_by_identity_id IS NULL))
);
CREATE INDEX checklist_tasks_employee_status ON public.checklist_tasks(tenant_id,employee_id,status,due_date);

DO $$
DECLARE period record; task_id uuid;
BEGIN
  FOR period IN SELECT ep.tenant_id,ep.id period_id,ep.employee_id,ep.final_working_date,
      ep.termination_scheduled_by_identity_id actor_id,ep.termination_reason
    FROM public.employment_periods ep WHERE ep.final_working_date IS NOT NULL
      AND ep.termination_scheduled_by_identity_id IS NOT NULL
  LOOP
    task_id:=gen_random_uuid();
    INSERT INTO public.checklist_tasks(id,tenant_id,employee_id,employment_period_id,lifecycle,
      task_code,title,assignee_identity_id,due_date,created_by_identity_id)
    VALUES(task_id,period.tenant_id,period.employee_id,period.period_id,'offboarding',
      'FINAL_SETTLEMENT_REVIEW','Review final settlement inputs',period.actor_id,
      period.final_working_date,period.actor_id) ON CONFLICT DO NOTHING;
    IF FOUND THEN
      INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
        VALUES(gen_random_uuid(),period.tenant_id,period.actor_id,'employee.checklist_created',
          period.termination_reason,task_id);
      INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
        VALUES(gen_random_uuid(),period.tenant_id,'employee.checklist.created.v1',task_id,1);
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.checklist_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.checklist_tasks
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION public.tenant_checklist_authorized(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT p_mfa_verified AND EXISTS (
    SELECT 1 FROM public.tenants t JOIN public.memberships m ON m.tenant_id=t.id
      JOIN public.identities i ON i.id=m.identity_id
    WHERE t.id=p_tenant AND t.status='active' AND i.id=p_actor AND i.status='active'
      AND m.status='active' AND m.roles && ARRAY['owner','hr_admin']::text[]
  )
$$;

CREATE FUNCTION public.read_tenant_employee_checklist(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid
) RETURNS TABLE(outcome varchar,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF NOT public.tenant_checklist_authorized(p_actor,p_mfa_verified,p_tenant) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::jsonb; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.tenant_id=p_tenant
    AND e.id=p_employee AND e.joining_date IS NOT NULL) THEN
    RETURN QUERY SELECT 'not_found'::varchar,NULL::jsonb; RETURN;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',t.id,'employmentPeriodId',t.employment_period_id,'lifecycle',t.lifecycle,
    'taskCode',t.task_code,'title',t.title,'assigneeIdentityId',t.assignee_identity_id,
    'dueDate',to_char(t.due_date,'YYYY-MM-DD'),'status',t.status,'version',t.version,
    'completedAt',t.completed_at,'completedByIdentityId',t.completed_by_identity_id
  ) ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END,t.due_date,t.created_at),'[]'::jsonb)
  INTO result FROM public.checklist_tasks t WHERE t.tenant_id=p_tenant AND t.employee_id=p_employee;
  RETURN QUERY SELECT 'ok'::varchar,jsonb_build_object('tasks',result);
END $$;

CREATE FUNCTION public.create_tenant_employee_checklist_task(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid,p_task uuid,
  p_lifecycle varchar,p_task_code varchar,p_title varchar,p_assignee uuid,
  p_due_date date,p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,task_id uuid,task_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_employee public.employees%ROWTYPE; current_period public.employment_periods%ROWTYPE;
BEGIN
  IF NOT public.tenant_checklist_authorized(p_actor,p_mfa_verified,p_tenant) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  IF p_lifecycle NOT IN ('onboarding','offboarding') OR p_task_code !~ '^[A-Z][A-Z0-9_]{0,49}$' OR
    p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 160 OR p_due_date IS NULL OR
    p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  SELECT e.* INTO current_employee FROM public.employees e WHERE e.tenant_id=p_tenant
    AND e.id=p_employee AND e.joining_date IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::uuid,NULL::integer; RETURN; END IF;
  SELECT ep.* INTO current_period FROM public.employment_periods ep WHERE ep.tenant_id=p_tenant
    AND ep.employee_id=p_employee ORDER BY ep.period_number DESC LIMIT 1;
  IF NOT FOUND OR p_due_date<current_period.joining_date OR
    (p_lifecycle='onboarding' AND (current_employee.status NOT IN ('draft','active') OR current_period.status NOT IN ('planned','active'))) OR
    (p_lifecycle='offboarding' AND (current_period.final_working_date IS NULL OR p_due_date>current_period.final_working_date)) OR
    NOT EXISTS (SELECT 1 FROM public.memberships m JOIN public.identities i ON i.id=m.identity_id
      WHERE m.tenant_id=p_tenant AND m.identity_id=p_assignee AND m.status='active'
      AND i.status='active' AND m.roles && ARRAY['owner','hr_admin']::text[]) THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.checklist_tasks t WHERE t.tenant_id=p_tenant
    AND t.employment_period_id=current_period.id AND t.task_code=p_task_code) THEN
    RETURN QUERY SELECT 'conflict'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  INSERT INTO public.checklist_tasks(id,tenant_id,employee_id,employment_period_id,lifecycle,
    task_code,title,assignee_identity_id,due_date,created_by_identity_id)
    VALUES(p_task,p_tenant,p_employee,current_period.id,p_lifecycle,p_task_code,btrim(p_title),
      p_assignee,p_due_date,p_actor);
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.checklist_created',btrim(p_reason),p_task);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.checklist.created.v1',p_task,1);
  RETURN QUERY SELECT 'created'::varchar,p_task,1;
END $$;

CREATE FUNCTION public.complete_tenant_employee_checklist_task(
  p_actor uuid,p_mfa_verified boolean,p_tenant uuid,p_employee uuid,p_task uuid,
  p_expected_version integer,p_reason varchar,p_audit uuid,p_outbox uuid
) RETURNS TABLE(outcome varchar,task_id uuid,task_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_task public.checklist_tasks%ROWTYPE; next_version integer;
BEGIN
  IF NOT public.tenant_checklist_authorized(p_actor,p_mfa_verified,p_tenant) THEN
    RETURN QUERY SELECT 'forbidden'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  IF p_expected_version<1 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 240 THEN
    RETURN QUERY SELECT 'invalid_state'::varchar,NULL::uuid,NULL::integer; RETURN;
  END IF;
  SELECT t.* INTO current_task FROM public.checklist_tasks t WHERE t.tenant_id=p_tenant
    AND t.employee_id=p_employee AND t.id=p_task FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::varchar,NULL::uuid,NULL::integer; RETURN; END IF;
  IF current_task.version<>p_expected_version THEN RETURN QUERY SELECT 'stale'::varchar,NULL::uuid,NULL::integer; RETURN; END IF;
  IF current_task.status<>'pending' THEN RETURN QUERY SELECT 'invalid_state'::varchar,NULL::uuid,NULL::integer; RETURN; END IF;
  next_version:=current_task.version+1;
  UPDATE public.checklist_tasks t SET status='completed',version=next_version,
    completed_at=now(),completed_by_identity_id=p_actor,updated_at=now()
    WHERE t.tenant_id=p_tenant AND t.id=p_task;
  INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
    VALUES(p_audit,p_tenant,p_actor,'employee.checklist_completed',btrim(p_reason),p_task);
  INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
    VALUES(p_outbox,p_tenant,'employee.checklist.completed.v1',p_task,next_version);
  RETURN QUERY SELECT 'updated'::varchar,p_task,next_version;
END $$;

CREATE FUNCTION public.create_final_settlement_checklist() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE task_id uuid;
BEGIN
  IF OLD.final_working_date IS NULL AND NEW.final_working_date IS NOT NULL
    AND NEW.termination_scheduled_by_identity_id IS NOT NULL THEN
    task_id:=gen_random_uuid();
    INSERT INTO public.checklist_tasks(id,tenant_id,employee_id,employment_period_id,lifecycle,
      task_code,title,assignee_identity_id,due_date,created_by_identity_id)
      VALUES(task_id,NEW.tenant_id,NEW.employee_id,NEW.id,'offboarding','FINAL_SETTLEMENT_REVIEW',
        'Review final settlement inputs',NEW.termination_scheduled_by_identity_id,
        NEW.final_working_date,NEW.termination_scheduled_by_identity_id);
    INSERT INTO public.audit_events(id,tenant_id,actor_id,action,reason,resource_id)
      VALUES(gen_random_uuid(),NEW.tenant_id,NEW.termination_scheduled_by_identity_id,
        'employee.checklist_created',NEW.termination_reason,task_id);
    INSERT INTO public.outbox_events(id,tenant_id,type,aggregate_id,aggregate_version)
      VALUES(gen_random_uuid(),NEW.tenant_id,'employee.checklist.created.v1',task_id,1);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employment_period_final_settlement AFTER UPDATE OF final_working_date ON public.employment_periods
  FOR EACH ROW EXECUTE FUNCTION public.create_final_settlement_checklist();

REVOKE ALL ON FUNCTION public.tenant_checklist_authorized(uuid,boolean,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_tenant_employee_checklist(uuid,boolean,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_tenant_employee_checklist_task(uuid,boolean,uuid,uuid,uuid,varchar,varchar,varchar,uuid,date,varchar,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_tenant_employee_checklist_task(uuid,boolean,uuid,uuid,uuid,integer,varchar,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_final_settlement_checklist() FROM PUBLIC;

COMMIT;
