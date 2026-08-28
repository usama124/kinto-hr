BEGIN;
-- Global control-plane identities: only an exact verified issuer/subject lookup
-- is visible to the runtime. Email addresses/domains never confer membership.
CREATE TABLE identities (
  id uuid PRIMARY KEY,
  issuer varchar(512) NOT NULL CHECK (length(issuer) > 0),
  subject varchar(255) NOT NULL CHECK (length(subject) > 0),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX identities_issuer_subject_key ON identities(issuer, subject);
ALTER TABLE identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE identities FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_scope ON identities FOR SELECT USING (
  issuer = nullif(current_setting('app.identity_issuer', true), '') AND
  subject = nullif(current_setting('app.identity_subject', true), '')
);
CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE RESTRICT,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  roles text[] NOT NULL CHECK (
    cardinality(roles) BETWEEN 1 AND 5 AND
    array_position(roles, NULL) IS NULL AND
    roles <@ ARRAY['owner', 'hr_admin', 'payroll_preparer', 'payroll_approver', 'employee']::text[]
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memberships_tenant_id_identity_id_key ON memberships(tenant_id, identity_id);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_scope ON memberships FOR SELECT USING (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND
  EXISTS (SELECT 1 FROM identities WHERE identities.id = memberships.identity_id)
);
COMMIT;
