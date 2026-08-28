BEGIN;
ALTER TABLE audit_events ADD COLUMN reason varchar(240);
CREATE UNIQUE INDEX outbox_events_tenant_id_id_key ON outbox_events(tenant_id, id);

CREATE TABLE job_deliveries (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retry', 'completed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error varchar(60),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, event_id) REFERENCES outbox_events(tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX job_deliveries_due_idx ON job_deliveries(available_at, event_id) WHERE status IN ('pending', 'retry');
CREATE UNIQUE INDEX job_deliveries_tenant_id_event_id_key ON job_deliveries(tenant_id, event_id);

CREATE TABLE consumer_receipts (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  consumer varchar(100) NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, event_id) REFERENCES outbox_events(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX consumer_receipts_tenant_id_event_id_key ON consumer_receipts(tenant_id, event_id);

ALTER TABLE job_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON job_deliveries USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE consumer_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON consumer_receipts USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Fixed SQL, fixed search path, no caller-supplied table names or tenant context.
-- Provisioning transfers ownership to a NOLOGIN role limited to delivery metadata.
CREATE FUNCTION public.enqueue_outbox_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.job_deliveries(event_id, tenant_id) VALUES (NEW.id, NEW.tenant_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_outbox_delivery() FROM PUBLIC;
CREATE TRIGGER outbox_delivery_insert AFTER INSERT ON outbox_events
FOR EACH ROW EXECUTE FUNCTION public.enqueue_outbox_delivery();

-- Upgrade existing committed events without changing their identity.
INSERT INTO job_deliveries(event_id, tenant_id) SELECT id, tenant_id FROM outbox_events;

CREATE FUNCTION public.pending_outbox(batch_size integer)
RETURNS TABLE ("eventId" uuid, "tenantId" uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT event_id, tenant_id FROM public.job_deliveries
  WHERE status IN ('pending', 'retry') AND available_at <= now()
  ORDER BY available_at, event_id
  LIMIT greatest(1, least(coalesce(batch_size, 100), 100));
$$;
REVOKE ALL ON FUNCTION public.pending_outbox(integer) FROM PUBLIC;

CREATE FUNCTION public.outbox_health()
RETURNS TABLE (status text, count bigint, "oldestDueAt" timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT status::text, count(*), min(available_at) FROM public.job_deliveries GROUP BY status;
$$;
REVOKE ALL ON FUNCTION public.outbox_health() FROM PUBLIC;
COMMIT;
