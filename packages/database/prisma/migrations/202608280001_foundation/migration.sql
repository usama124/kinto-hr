CREATE TABLE tenants (
  id uuid PRIMARY KEY, name varchar(160) NOT NULL,
  employee_limit integer NOT NULL CHECK (employee_limit >= 0 AND employee_limit <= 250),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  billing_mode varchar(20) NOT NULL DEFAULT 'free' CHECK (billing_mode IN ('free', 'complimentary', 'manual_paid')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE employees (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  employee_number varchar(40) NOT NULL, name varchar(160) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'terminated', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX employees_tenant_id_id_key ON employees(tenant_id, id);
CREATE UNIQUE INDEX employees_tenant_id_employee_number_key ON employees(tenant_id, employee_number);
CREATE INDEX employees_tenant_id_status_idx ON employees(tenant_id, status);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL, action varchar(100) NOT NULL, resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_id_created_at_idx ON audit_events(tenant_id, created_at);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  type varchar(100) NOT NULL, aggregate_id uuid NOT NULL, aggregate_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX outbox_events_tenant_id_aggregate_id_aggregate_version_type_key ON outbox_events(tenant_id, aggregate_id, aggregate_version, type);
CREATE INDEX outbox_events_tenant_id_created_at_idx ON outbox_events(tenant_id, created_at);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON tenants FOR SELECT USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON employees USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON audit_events USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON outbox_events USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
