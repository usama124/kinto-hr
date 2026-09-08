'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import {
  organizationPolicyPreviewSchema,
  organizationSnapshotSchema,
  type OrganizationSnapshot,
} from '@kinto/contracts';

type ViewState =
  'loading' | 'ready' | 'select-company' | 'signed-out' | 'denied' | 'error';
type Province = (typeof provinces)[number]['code'];
const provinces = [
  { code: 'PK-BA', name: 'Balochistan' },
  { code: 'PK-GB', name: 'Gilgit-Baltistan' },
  { code: 'PK-IS', name: 'Islamabad Capital Territory' },
  { code: 'PK-JK', name: 'Azad Jammu and Kashmir' },
  { code: 'PK-KP', name: 'Khyber Pakhtunkhwa' },
  { code: 'PK-PB', name: 'Punjab' },
  { code: 'PK-SD', name: 'Sindh' },
] as const;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const todayInKarachi = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

export default function Organization() {
  const [state, setState] = useState<ViewState>('loading');
  const [tenantId, setTenantId] = useState('');
  const [csrf, setCsrf] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [snapshot, setSnapshot] = useState<OrganizationSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [legalName, setLegalName] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  const [legalProvince, setLegalProvince] = useState<Province>('PK-PB');
  const [legalReason, setLegalReason] = useState('');
  const [editingBranchId, setEditingBranchId] = useState<string | null>(null);
  const [branchCode, setBranchCode] = useState('');
  const [branchName, setBranchName] = useState('');
  const [branchProvince, setBranchProvince] = useState<Province>('PK-PB');
  const [branchStatus, setBranchStatus] = useState<'active' | 'inactive'>(
    'active',
  );
  const [branchReason, setBranchReason] = useState('');
  const [editingDepartmentId, setEditingDepartmentId] = useState<string | null>(
    null,
  );
  const [departmentCode, setDepartmentCode] = useState('');
  const [departmentName, setDepartmentName] = useState('');
  const [departmentStatus, setDepartmentStatus] = useState<
    'active' | 'inactive'
  >('active');
  const [departmentReason, setDepartmentReason] = useState('');
  const [editingDesignationId, setEditingDesignationId] = useState<
    string | null
  >(null);
  const [designationCode, setDesignationCode] = useState('');
  const [designationName, setDesignationName] = useState('');
  const [designationStatus, setDesignationStatus] = useState<
    'active' | 'inactive'
  >('active');
  const [designationReason, setDesignationReason] = useState('');
  const [policyBranchId, setPolicyBranchId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayInKarachi());
  const [policyReason, setPolicyReason] = useState('');
  const [preview, setPreview] = useState<ReturnType<
    typeof organizationPolicyPreviewSchema.parse
  > | null>(null);
  const [publishReason, setPublishReason] = useState('');

  function applySnapshot(data: OrganizationSnapshot) {
    setSnapshot(data);
    if (data.legalEntity) {
      setLegalName(data.legalEntity.legalName);
      setRegistrationNumber(data.legalEntity.registrationNumber ?? '');
      setTaxNumber(data.legalEntity.taxNumber ?? '');
      setLegalProvince(data.legalEntity.provinceCode);
    }
    if (!policyBranchId) {
      const defaultId =
        data.publishedPolicy?.settings.defaultBranchId ??
        data.branches.find((branch) => branch.status === 'active')?.id ??
        '';
      setPolicyBranchId(defaultId);
    }
  }

  async function loadOrganization(selectedTenantId: string) {
    const response = await fetch(
      `/api/v1/tenants/${selectedTenantId}/organization`,
      { cache: 'no-store' },
    );
    if (response.status === 401) return setState('signed-out');
    if (response.status === 403) return setState('denied');
    if (!response.ok) throw new Error('Unavailable');
    applySnapshot(organizationSnapshotSchema.parse(await response.json()));
    setState('ready');
  }

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/v1/auth/session', {
          cache: 'no-store',
        });
        if (response.status === 401 || response.status === 404)
          return setState('signed-out');
        if (!response.ok) throw new Error('Unavailable');
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== 'object' ||
          !('csrfToken' in data) ||
          typeof data.csrfToken !== 'string' ||
          !('selectedTenantId' in data) ||
          typeof data.selectedTenantId !== 'string' ||
          !uuid.test(data.selectedTenantId) ||
          !('tenants' in data) ||
          !Array.isArray(data.tenants)
        ) {
          if (
            data &&
            typeof data === 'object' &&
            'selectedTenantId' in data &&
            data.selectedTenantId === null
          )
            return setState('select-company');
          throw new Error('Invalid session');
        }
        const tenant = data.tenants.find(
          (candidate: unknown) =>
            !!candidate &&
            typeof candidate === 'object' &&
            'id' in candidate &&
            candidate.id === data.selectedTenantId &&
            'name' in candidate &&
            typeof candidate.name === 'string' &&
            'roles' in candidate &&
            Array.isArray(candidate.roles),
        );
        if (!tenant || !('name' in tenant) || !('roles' in tenant))
          throw new Error('Invalid company');
        setTenantId(data.selectedTenantId);
        setCsrf(data.csrfToken);
        setCompanyName(String(tenant.name));
        setCanManage(tenant.roles.includes('owner'));
        await loadOrganization(data.selectedTenantId);
      } catch {
        setState('error');
      }
    })();
  }, []);

  async function mutate(path: string, method: 'POST' | 'PUT', body: unknown) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/organization${path}`,
        {
          method,
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify(body),
        },
      );
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== 'object' ||
        !('id' in result) ||
        typeof result.id !== 'string' ||
        !uuid.test(result.id) ||
        !('version' in result) ||
        typeof result.version !== 'number'
      )
        throw new Error('Invalid response');
      await loadOrganization(tenantId);
      setMessage('Saved successfully.');
      return result;
    } catch {
      setMessage('The change could not be saved. Refresh and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function saveLegalEntity(event: FormEvent) {
    event.preventDefault();
    if (!snapshot) return;
    const fields = {
      legalName,
      ...(registrationNumber.trim() ? { registrationNumber } : {}),
      ...(taxNumber.trim() ? { taxNumber } : {}),
      provinceCode: legalProvince,
      reason: legalReason,
    };
    const existing = snapshot.legalEntity;
    await mutate(
      existing ? `/legal-entities/${existing.id}` : '/legal-entities',
      existing ? 'PUT' : 'POST',
      existing ? { expectedVersion: existing.version, ...fields } : fields,
    );
    setLegalReason('');
  }

  async function saveBranch(event: FormEvent) {
    event.preventDefault();
    if (!snapshot) return;
    const existing = snapshot.branches.find(({ id }) => id === editingBranchId);
    await mutate(
      existing ? `/branches/${existing.id}` : '/branches',
      existing ? 'PUT' : 'POST',
      {
        ...(existing ? { expectedVersion: existing.version } : {}),
        code: branchCode,
        name: branchName,
        provinceCode: branchProvince,
        ...(existing ? { status: branchStatus } : {}),
        reason: branchReason,
      },
    );
    setEditingBranchId(null);
    setBranchCode('');
    setBranchName('');
    setBranchStatus('active');
    setBranchReason('');
  }

  function editBranch(branchId: string) {
    const branch = snapshot?.branches.find(({ id }) => id === branchId);
    if (!branch) return;
    setEditingBranchId(branch.id);
    setBranchCode(branch.code);
    setBranchName(branch.name);
    setBranchProvince(branch.provinceCode);
    setBranchStatus(branch.status);
    setBranchReason('');
  }

  async function saveDepartment(event: FormEvent) {
    event.preventDefault();
    if (!snapshot) return;
    const existing = snapshot.departments.find(
      ({ id }) => id === editingDepartmentId,
    );
    await mutate(
      existing ? `/departments/${existing.id}` : '/departments',
      existing ? 'PUT' : 'POST',
      {
        ...(existing ? { expectedVersion: existing.version } : {}),
        code: departmentCode,
        name: departmentName,
        ...(existing ? { status: departmentStatus } : {}),
        reason: departmentReason,
      },
    );
    setEditingDepartmentId(null);
    setDepartmentCode('');
    setDepartmentName('');
    setDepartmentStatus('active');
    setDepartmentReason('');
  }

  function editDepartment(id: string) {
    const item = snapshot?.departments.find((entry) => entry.id === id);
    if (!item) return;
    setEditingDepartmentId(item.id);
    setDepartmentCode(item.code);
    setDepartmentName(item.name);
    setDepartmentStatus(item.status);
    setDepartmentReason('');
  }

  async function saveDesignation(event: FormEvent) {
    event.preventDefault();
    if (!snapshot) return;
    const existing = snapshot.designations.find(
      ({ id }) => id === editingDesignationId,
    );
    await mutate(
      existing ? `/designations/${existing.id}` : '/designations',
      existing ? 'PUT' : 'POST',
      {
        ...(existing ? { expectedVersion: existing.version } : {}),
        code: designationCode,
        name: designationName,
        ...(existing ? { status: designationStatus } : {}),
        reason: designationReason,
      },
    );
    setEditingDesignationId(null);
    setDesignationCode('');
    setDesignationName('');
    setDesignationStatus('active');
    setDesignationReason('');
  }

  function editDesignation(id: string) {
    const item = snapshot?.designations.find((entry) => entry.id === id);
    if (!item) return;
    setEditingDesignationId(item.id);
    setDesignationCode(item.code);
    setDesignationName(item.name);
    setDesignationStatus(item.status);
    setDesignationReason('');
  }

  async function createPolicy(event: FormEvent) {
    event.preventDefault();
    if (!snapshot) return;
    const result = await mutate(
      '/policies/organization-defaults/drafts',
      'POST',
      {
        expectedCurrentVersion: snapshot.latestPublishedVersion,
        effectiveFrom,
        settings: { defaultBranchId: policyBranchId },
        reason: policyReason,
      },
    );
    setPolicyReason('');
    if (result && 'id' in result) await showPreview(String(result.id));
  }

  async function showPreview(policyId: string) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/organization/policies/organization-defaults/drafts/${policyId}/preview`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error('Preview failed');
      setPreview(organizationPolicyPreviewSchema.parse(await response.json()));
    } catch {
      setMessage('The policy preview is unavailable.');
    } finally {
      setBusy(false);
    }
  }

  async function publishPolicy(event: FormEvent) {
    event.preventDefault();
    if (!preview) return;
    const result = await mutate(
      `/policies/organization-defaults/drafts/${preview.id}/publication`,
      'POST',
      { expectedVersion: preview.version, reason: publishReason },
    );
    if (result) {
      setPreview(null);
      setPublishReason('');
    }
  }

  if (state !== 'ready' || !snapshot) {
    const copy = {
      loading: 'Loading company setup…',
      ready: '',
      'select-company':
        'Choose a company workspace before opening company setup.',
      'signed-out': 'Sign in to open company setup.',
      denied:
        'Recent multi-factor authentication and company access are required.',
      error: 'Company setup is unavailable. Refresh and try again.',
    }[state];
    return (
      <section className="notice">
        <p role={state === 'error' ? 'alert' : 'status'}>{copy}</p>
        {(state === 'signed-out' || state === 'select-company') && (
          <Link href="/login">Open account access →</Link>
        )}
      </section>
    );
  }

  const activeBranches = snapshot.branches.filter(
    ({ status }) => status === 'active',
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">COMPANY SETUP</p>
          <h1>{companyName}</h1>
          <p className="subtitle">
            Legal employer, branches, departments, designations and published
            organization defaults.
          </p>
        </div>
      </div>
      {!canManage && (
        <div className="notice">
          <strong>Read-only access.</strong>
          <p>
            Only a company owner with recent MFA can change organization
            settings.
          </p>
        </div>
      )}
      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
      <section className="organization-grid">
        <article className="settings-card">
          <div className="section-heading">
            <h2>Legal employer</h2>
            <span>PK · PKR · Asia/Karachi</span>
          </div>
          <form className="settings-form" onSubmit={saveLegalEntity}>
            <label>
              Legal name
              <input
                required
                maxLength={160}
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                disabled={!canManage}
              />
            </label>
            <label>
              Registration number
              <input
                maxLength={80}
                value={registrationNumber}
                onChange={(e) => setRegistrationNumber(e.target.value)}
                disabled={!canManage}
              />
            </label>
            <label>
              Tax number
              <input
                maxLength={80}
                value={taxNumber}
                onChange={(e) => setTaxNumber(e.target.value)}
                disabled={!canManage}
              />
            </label>
            <label>
              Province / territory
              <select
                value={legalProvince}
                onChange={(e) => setLegalProvince(e.target.value as Province)}
                disabled={!canManage}
              >
                {provinces.map((province) => (
                  <option value={province.code} key={province.code}>
                    {province.name}
                  </option>
                ))}
              </select>
            </label>
            {canManage && (
              <>
                <label>
                  Reason
                  <input
                    required
                    minLength={3}
                    maxLength={240}
                    value={legalReason}
                    onChange={(e) => setLegalReason(e.target.value)}
                  />
                </label>
                <button className="primary-button" disabled={busy}>
                  {snapshot.legalEntity
                    ? 'Save legal employer'
                    : 'Create legal employer'}
                </button>
              </>
            )}
          </form>
        </article>

        <article className="settings-card">
          <div className="section-heading">
            <h2>Branches</h2>
            <span>{snapshot.branches.length} configured</span>
          </div>
          <ul className="branch-list">
            {snapshot.branches.map((branch) => (
              <li key={branch.id}>
                <div>
                  <strong>
                    {branch.code} · {branch.name}
                  </strong>
                  <small>
                    {branch.provinceCode} · {branch.status}
                  </small>
                </div>
                {canManage && (
                  <button
                    className="secondary-button"
                    onClick={() => editBranch(branch.id)}
                  >
                    Edit
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canManage && snapshot.legalEntity && (
            <form className="settings-form compact" onSubmit={saveBranch}>
              <h3>{editingBranchId ? 'Edit branch' : 'Add branch'}</h3>
              <label>
                Code
                <input
                  required
                  maxLength={20}
                  pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                  value={branchCode}
                  onChange={(e) => setBranchCode(e.target.value)}
                />
              </label>
              <label>
                Name
                <input
                  required
                  maxLength={160}
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                />
              </label>
              <label>
                Province / territory
                <select
                  value={branchProvince}
                  onChange={(e) =>
                    setBranchProvince(e.target.value as Province)
                  }
                >
                  {provinces.map((province) => (
                    <option value={province.code} key={province.code}>
                      {province.name}
                    </option>
                  ))}
                </select>
              </label>
              {editingBranchId && (
                <label>
                  Status
                  <select
                    value={branchStatus}
                    onChange={(e) =>
                      setBranchStatus(e.target.value as 'active' | 'inactive')
                    }
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
              )}
              <label>
                Reason
                <input
                  required
                  minLength={3}
                  maxLength={240}
                  value={branchReason}
                  onChange={(e) => setBranchReason(e.target.value)}
                />
              </label>
              <button className="primary-button" disabled={busy}>
                {editingBranchId ? 'Save branch' : 'Add branch'}
              </button>
            </form>
          )}
        </article>
      </section>

      <section className="organization-grid">
        <article className="settings-card">
          <div className="section-heading">
            <h2>Departments</h2>
            <span>{snapshot.departments.length} configured</span>
          </div>
          <ul className="branch-list">
            {snapshot.departments.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>
                    {item.code} · {item.name}
                  </strong>
                  <small>{item.status}</small>
                </div>
                {canManage && (
                  <button
                    className="secondary-button"
                    onClick={() => editDepartment(item.id)}
                  >
                    Edit
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <form className="settings-form compact" onSubmit={saveDepartment}>
              <h3>
                {editingDepartmentId ? 'Edit department' : 'Add department'}
              </h3>
              <label>
                Code
                <input
                  required
                  maxLength={20}
                  pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                  value={departmentCode}
                  onChange={(event) => setDepartmentCode(event.target.value)}
                />
              </label>
              <label>
                Name
                <input
                  required
                  maxLength={160}
                  value={departmentName}
                  onChange={(event) => setDepartmentName(event.target.value)}
                />
              </label>
              {editingDepartmentId && (
                <label>
                  Status
                  <select
                    value={departmentStatus}
                    onChange={(event) =>
                      setDepartmentStatus(
                        event.target.value as 'active' | 'inactive',
                      )
                    }
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
              )}
              <label>
                Reason
                <input
                  required
                  minLength={3}
                  maxLength={240}
                  value={departmentReason}
                  onChange={(event) => setDepartmentReason(event.target.value)}
                />
              </label>
              <button className="primary-button" disabled={busy}>
                {editingDepartmentId ? 'Save department' : 'Add department'}
              </button>
            </form>
          )}
        </article>

        <article className="settings-card">
          <div className="section-heading">
            <h2>Designations</h2>
            <span>{snapshot.designations.length} configured</span>
          </div>
          <ul className="branch-list">
            {snapshot.designations.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>
                    {item.code} · {item.name}
                  </strong>
                  <small>{item.status}</small>
                </div>
                {canManage && (
                  <button
                    className="secondary-button"
                    onClick={() => editDesignation(item.id)}
                  >
                    Edit
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <form className="settings-form compact" onSubmit={saveDesignation}>
              <h3>
                {editingDesignationId ? 'Edit designation' : 'Add designation'}
              </h3>
              <label>
                Code
                <input
                  required
                  maxLength={20}
                  pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                  value={designationCode}
                  onChange={(event) => setDesignationCode(event.target.value)}
                />
              </label>
              <label>
                Name
                <input
                  required
                  maxLength={160}
                  value={designationName}
                  onChange={(event) => setDesignationName(event.target.value)}
                />
              </label>
              {editingDesignationId && (
                <label>
                  Status
                  <select
                    value={designationStatus}
                    onChange={(event) =>
                      setDesignationStatus(
                        event.target.value as 'active' | 'inactive',
                      )
                    }
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
              )}
              <label>
                Reason
                <input
                  required
                  minLength={3}
                  maxLength={240}
                  value={designationReason}
                  onChange={(event) => setDesignationReason(event.target.value)}
                />
              </label>
              <button className="primary-button" disabled={busy}>
                {editingDesignationId ? 'Save designation' : 'Add designation'}
              </button>
            </form>
          )}
        </article>
      </section>

      <section className="settings-card policy-card">
        <div className="section-heading">
          <h2>Organization defaults</h2>
          <span>Effective-dated policy</span>
        </div>
        <p>
          Current default branch:{' '}
          <strong>
            {snapshot.branches.find(
              ({ id }) =>
                id === snapshot.publishedPolicy?.settings.defaultBranchId,
            )?.name ?? 'Not published'}
          </strong>
        </p>
        {canManage && activeBranches.length > 0 && (
          <form className="policy-form" onSubmit={createPolicy}>
            <label>
              Default branch
              <select
                required
                value={policyBranchId}
                onChange={(e) => setPolicyBranchId(e.target.value)}
              >
                {activeBranches.map((branch) => (
                  <option value={branch.id} key={branch.id}>
                    {branch.code} · {branch.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Effective from
              <input
                required
                type="date"
                min={todayInKarachi()}
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </label>
            <label>
              Draft reason
              <input
                required
                minLength={3}
                maxLength={240}
                value={policyReason}
                onChange={(e) => setPolicyReason(e.target.value)}
              />
            </label>
            <button className="primary-button" disabled={busy}>
              Create policy draft
            </button>
          </form>
        )}
        {snapshot.policyDrafts.length > 0 && (
          <div className="policy-drafts">
            <h3>Draft proposals</h3>
            {snapshot.policyDrafts.map((draft) => (
              <button
                className="workspace-choice"
                key={draft.id}
                onClick={() => void showPreview(draft.id)}
                disabled={busy}
              >
                <strong>
                  Version {draft.version} · {draft.effectiveFrom}
                </strong>
                <span>Preview</span>
              </button>
            ))}
          </div>
        )}
        {preview && (
          <form className="policy-preview" onSubmit={publishPolicy}>
            <p>
              <strong>Preview version {preview.version}</strong>
            </p>
            <p>
              From {preview.effectiveFrom}, {preview.defaultBranch.code} ·{' '}
              {preview.defaultBranch.name} becomes the default branch. No open
              attendance or payroll periods exist in this phase.
            </p>
            {canManage && (
              <>
                <label>
                  Publication reason
                  <input
                    required
                    minLength={3}
                    maxLength={240}
                    value={publishReason}
                    onChange={(e) => setPublishReason(e.target.value)}
                  />
                </label>
                <button className="primary-button" disabled={busy}>
                  Publish policy
                </button>
              </>
            )}
          </form>
        )}
        <p className="audit-note">
          Attendance, leave, absence and payroll settings remain unavailable
          until their validated modules are implemented.
        </p>
      </section>
    </>
  );
}
