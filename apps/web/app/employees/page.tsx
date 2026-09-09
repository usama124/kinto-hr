'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import {
  employeeRosterSchema,
  organizationSnapshotSchema,
  type EmployeeRoster,
  type OrganizationSnapshot,
} from '@kinto/contracts';

type ViewState =
  'loading' | 'ready' | 'select-company' | 'signed-out' | 'denied' | 'error';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const todayInKarachi = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

export default function Employees() {
  const [state, setState] = useState<ViewState>('loading');
  const [tenantId, setTenantId] = useState('');
  const [csrf, setCsrf] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [roster, setRoster] = useState<EmployeeRoster>({ employees: [] });
  const [organization, setOrganization] = useState<OrganizationSnapshot | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [employeeNumber, setEmployeeNumber] = useState('');
  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [joiningDate, setJoiningDate] = useState(todayInKarachi());
  const [branchId, setBranchId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [designationId, setDesignationId] = useState('');
  const [managerEmployeeId, setManagerEmployeeId] = useState('');
  const [topLevelReason, setTopLevelReason] = useState('');
  const [reason, setReason] = useState('');

  async function load(selectedTenantId: string) {
    const [employeeResponse, organizationResponse] = await Promise.all([
      fetch(`/api/v1/tenants/${selectedTenantId}/employees`, {
        cache: 'no-store',
      }),
      fetch(`/api/v1/tenants/${selectedTenantId}/organization`, {
        cache: 'no-store',
      }),
    ]);
    if (employeeResponse.status === 401 || organizationResponse.status === 401)
      return setState('signed-out');
    if (employeeResponse.status === 403 || organizationResponse.status === 403)
      return setState('denied');
    if (!employeeResponse.ok || !organizationResponse.ok)
      throw new Error('Unavailable');
    const employees = employeeRosterSchema.parse(await employeeResponse.json());
    const company = organizationSnapshotSchema.parse(
      await organizationResponse.json(),
    );
    setRoster(employees);
    setOrganization(company);
    setBranchId(
      (current) =>
        current ||
        company.branches.find(({ status }) => status === 'active')?.id ||
        '',
    );
    setDepartmentId(
      (current) =>
        current ||
        company.departments.find(({ status }) => status === 'active')?.id ||
        '',
    );
    setDesignationId(
      (current) =>
        current ||
        company.designations.find(({ status }) => status === 'active')?.id ||
        '',
    );
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
          !('selectedTenantId' in data) ||
          !('csrfToken' in data) ||
          typeof data.csrfToken !== 'string' ||
          !('tenants' in data) ||
          !Array.isArray(data.tenants)
        )
          throw new Error('Invalid session');
        if (data.selectedTenantId === null) return setState('select-company');
        if (
          typeof data.selectedTenantId !== 'string' ||
          !uuid.test(data.selectedTenantId)
        )
          throw new Error('Invalid tenant');
        const tenant = data.tenants.find(
          (candidate: unknown) =>
            !!candidate &&
            typeof candidate === 'object' &&
            'id' in candidate &&
            candidate.id === data.selectedTenantId &&
            'name' in candidate &&
            typeof candidate.name === 'string',
        );
        if (!tenant || !('name' in tenant)) throw new Error('Invalid company');
        setTenantId(data.selectedTenantId);
        setCsrf(data.csrfToken);
        setCompanyName(String(tenant.name));
        await load(data.selectedTenantId);
      } catch {
        setState('error');
      }
    })();
  }, []);

  async function createEmployee(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/v1/tenants/${tenantId}/employees`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({
          employeeNumber,
          name,
          ...(legalName.trim() ? { legalName } : {}),
          joiningDate,
          employmentType: 'monthly_salaried',
          branchId,
          departmentId,
          designationId,
          managerEmployeeId: managerEmployeeId || null,
          ...(managerEmployeeId ? {} : { topLevelReason }),
          reason,
        }),
      });
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      await load(tenantId);
      setEmployeeNumber('');
      setName('');
      setLegalName('');
      setManagerEmployeeId('');
      setTopLevelReason('');
      setReason('');
      setMessage('Employee draft created. Payroll setup remains incomplete.');
    } catch {
      setMessage(
        'The employee could not be created. Check unique number and organization selections.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function activateEmployee(
    event: FormEvent<HTMLFormElement>,
    employeeId: string,
    expectedVersion: number,
  ) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/activate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
          },
          body: JSON.stringify({
            expectedVersion,
            reason: form.get('activationReason'),
          }),
        },
      );
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      await load(tenantId);
      setMessage('Employee activated and an employee seat was allocated.');
    } catch {
      setMessage(
        'Activation was blocked. Check record readiness, current version and available employee capacity.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (state !== 'ready' || !organization) {
    const copy = {
      loading: 'Loading employee records…',
      ready: '',
      'select-company': 'Choose a company workspace before managing employees.',
      'signed-out': 'Sign in to manage employee records.',
      denied: 'HR access with recent multi-factor authentication is required.',
      error: 'Employee records are unavailable. Refresh and try again.',
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

  const setupReady =
    organization.branches.some(({ status }) => status === 'active') &&
    organization.departments.some(({ status }) => status === 'active') &&
    organization.designations.some(({ status }) => status === 'active');
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">EMPLOYEE RECORDS</p>
          <h1>{companyName}</h1>
          <p className="subtitle">
            Monthly-salaried employee records, explicit seat-backed activation
            and effective organization history.
          </p>
        </div>
      </div>
      <div className="people-grid">
        <section className="settings-card" aria-labelledby="roster-heading">
          <div className="section-heading">
            <h2 id="roster-heading">Employee roster</h2>
            <span>{roster.employees.length} records</span>
          </div>
          {roster.employees.length === 0 ? (
            <p className="empty-state">No complete employee records yet.</p>
          ) : (
            <ol className="employee-list">
              {roster.employees.map((employee) => (
                <li key={employee.id} className="employee-row">
                  <div className="employee-summary">
                    <div>
                      <strong>{employee.name}</strong>
                      <small>
                        {employee.employeeNumber} ·{' '}
                        {employee.currentAssignment?.designation.name ??
                          'Future start'}
                      </small>
                    </div>
                    <div>
                      <span className="preview-badge">{employee.status}</span>
                      <small>
                        {employee.currentAssignment?.department.name ??
                          employee.joiningDate}
                      </small>
                    </div>
                  </div>
                  {employee.status === 'draft' && (
                    <form
                      className="employee-activation"
                      onSubmit={(event) =>
                        activateEmployee(event, employee.id, employee.version)
                      }
                    >
                      <label>
                        Activation reason for {employee.name}
                        <input
                          name="activationReason"
                          required
                          minLength={3}
                          maxLength={240}
                        />
                      </label>
                      <button className="secondary-button" disabled={busy}>
                        {busy ? 'Activating…' : 'Activate employee'}
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
        <section
          className="settings-card"
          aria-labelledby="employee-create-heading"
        >
          <div className="section-heading">
            <h2 id="employee-create-heading">Add employee</h2>
            <span>Creates a draft</span>
          </div>
          {!setupReady ? (
            <div className="notice">
              <p>Create an active branch, department and designation first.</p>
              <Link href="/organization">Open company setup →</Link>
            </div>
          ) : (
            <form className="settings-form" onSubmit={createEmployee}>
              <label>
                Employee number
                <input
                  required
                  maxLength={40}
                  pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                  value={employeeNumber}
                  onChange={(e) => setEmployeeNumber(e.target.value)}
                />
              </label>
              <label>
                Display name
                <input
                  required
                  maxLength={160}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Legal name <small>Optional when same as display name</small>
                <input
                  maxLength={160}
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                />
              </label>
              <label>
                Joining date
                <input
                  required
                  type="date"
                  value={joiningDate}
                  onChange={(e) => setJoiningDate(e.target.value)}
                />
              </label>
              <label>
                Employment type
                <select value="monthly_salaried" disabled>
                  <option value="monthly_salaried">Monthly salaried</option>
                </select>
              </label>
              <label>
                Branch
                <select
                  required
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                >
                  {organization.branches
                    .filter(({ status }) => status === 'active')
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.code} · {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Department
                <select
                  required
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                >
                  {organization.departments
                    .filter(({ status }) => status === 'active')
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.code} · {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Designation
                <select
                  required
                  value={designationId}
                  onChange={(e) => setDesignationId(e.target.value)}
                >
                  {organization.designations
                    .filter(({ status }) => status === 'active')
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.code} · {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Reporting manager
                <select
                  value={managerEmployeeId}
                  onChange={(e) => setManagerEmployeeId(e.target.value)}
                >
                  <option value="">No manager · top-level exception</option>
                  {roster.employees
                    .filter(
                      ({ status }) => status === 'draft' || status === 'active',
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.employeeNumber} · {item.name}
                      </option>
                    ))}
                </select>
              </label>
              {!managerEmployeeId && (
                <label>
                  Top-level exception
                  <input
                    required
                    minLength={3}
                    maxLength={240}
                    value={topLevelReason}
                    onChange={(e) => setTopLevelReason(e.target.value)}
                  />
                </label>
              )}
              <label>
                Audit reason
                <input
                  required
                  minLength={3}
                  maxLength={240}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button className="primary-button" disabled={busy}>
                {busy ? 'Saving…' : 'Create employee draft'}
              </button>
            </form>
          )}
          {message && (
            <p className="form-message" role="status">
              {message}
            </p>
          )}
        </section>
      </div>
      <p className="audit-note">
        Employee numbers are unique inside this company. Salary, CNIC, bank and
        emergency details are intentionally outside this public record.
      </p>
    </>
  );
}
