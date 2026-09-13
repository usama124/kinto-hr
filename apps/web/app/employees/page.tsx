'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import {
  employeeRosterSchema,
  employeePrivateDetailsResponseSchema,
  employeeCompensationResponseSchema,
  organizationSnapshotSchema,
  type EmployeeRoster,
  type EmployeePrivateDetailsResponse,
  type EmployeeCompensationResponse,
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
  const [tenantRoles, setTenantRoles] = useState<string[]>([]);
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
  const [rehireManagers, setRehireManagers] = useState<Record<string, string>>(
    {},
  );
  const [privateDetails, setPrivateDetails] = useState<
    Record<string, EmployeePrivateDetailsResponse>
  >({});
  const [compensation, setCompensation] = useState<
    Record<string, EmployeeCompensationResponse>
  >({});
  type CompensationDraft = {
    code: string;
    name: string;
    kind: 'basic_salary' | 'allowance' | 'deduction';
    monthlyAmount: string;
  };
  const [compensationDrafts, setCompensationDrafts] = useState<
    Record<string, CompensationDraft[]>
  >({});

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
        if ('roles' in tenant && Array.isArray(tenant.roles))
          setTenantRoles(
            tenant.roles.filter(
              (role: unknown): role is string => typeof role === 'string',
            ),
          );
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

  async function loadPrivateDetails(employeeId: string) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/private-details`,
        { cache: 'no-store' },
      );
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      const details = employeePrivateDetailsResponseSchema.parse(
        await response.json(),
      );
      setPrivateDetails((current) => ({ ...current, [employeeId]: details }));
    } catch {
      setMessage('Private employee details could not be loaded.');
    } finally {
      setBusy(false);
    }
  }

  async function savePrivateDetails(
    event: FormEvent<HTMLFormElement>,
    employeeId: string,
  ) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const form = new FormData(event.currentTarget);
    const nullable = (name: string) =>
      String(form.get(name) || '').trim() || null;
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/private-details`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
          },
          body: JSON.stringify({
            expectedVersion: privateDetails[employeeId]?.details?.version ?? 0,
            personalEmail: nullable('personalEmail'),
            mobilePhone: nullable('mobilePhone'),
            residentialAddress: nullable('residentialAddress'),
            emergencyContactName: nullable('emergencyContactName'),
            emergencyContactPhone: nullable('emergencyContactPhone'),
            cnic: nullable('cnic'),
            reason: form.get('privateDetailsReason'),
          }),
        },
      );
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      await loadPrivateDetails(employeeId);
      setMessage('Private employee details saved with an audit record.');
    } catch {
      setMessage(
        'Private details were not saved. Check contact formats, emergency contact pair and current version.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadCompensation(employeeId: string) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/compensation`,
        { cache: 'no-store' },
      );
      if (response.status === 403) throw new Error('Forbidden');
      if (!response.ok) throw new Error('Request failed');
      const result = employeeCompensationResponseSchema.parse(
        await response.json(),
      );
      setCompensation((current) => ({ ...current, [employeeId]: result }));
      setCompensationDrafts((current) => ({
        ...current,
        [employeeId]: result.agreement?.revisions[0]?.components.map(
          (component) => ({ ...component }),
        ) ?? [
          {
            code: 'BASIC',
            name: 'Monthly basic salary',
            kind: 'basic_salary',
            monthlyAmount: '',
          },
        ],
      }));
    } catch {
      setMessage('Compensation is unavailable for this account or employee.');
    } finally {
      setBusy(false);
    }
  }

  function updateCompensationDraft(
    employeeId: string,
    index: number,
    update: Partial<CompensationDraft>,
  ) {
    setCompensationDrafts((current) => ({
      ...current,
      [employeeId]: current[employeeId].map((component, componentIndex) =>
        componentIndex === index ? { ...component, ...update } : component,
      ),
    }));
  }

  async function saveCompensation(
    event: FormEvent<HTMLFormElement>,
    employeeId: string,
  ) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/compensation`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
          },
          body: JSON.stringify({
            expectedAgreementVersion:
              compensation[employeeId]?.agreement?.version ?? 0,
            effectiveFrom: form.get('compensationEffectiveFrom'),
            components: compensationDrafts[employeeId],
            reason: form.get('compensationReason'),
          }),
        },
      );
      if (response.status === 403) throw new Error('Forbidden');
      if (!response.ok) throw new Error('Request failed');
      await Promise.all([loadCompensation(employeeId), load(tenantId)]);
      setMessage(
        'Compensation revision saved. Earlier rates remain unchanged.',
      );
    } catch {
      setMessage(
        'Compensation was not saved. Check permissions, amounts, component codes, date and current version.',
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

  async function scheduleTermination(
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
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/terminate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
          },
          body: JSON.stringify({
            expectedVersion,
            finalWorkingDate: form.get('finalWorkingDate'),
            reason: form.get('terminationReason'),
          }),
        },
      );
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      await load(tenantId);
      setMessage(
        'Termination scheduled. Access remains active through the final working date.',
      );
    } catch {
      setMessage(
        'Termination was blocked. Check the date, employee version and future reporting assignments.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function archiveEmployee(
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
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/archive`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
          },
          body: JSON.stringify({
            expectedVersion,
            reason: form.get('archiveReason'),
          }),
        },
      );
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      await load(tenantId);
      setMessage('Employee archived. Employment history remains available.');
    } catch {
      setMessage(
        'Archive was blocked. Only a completed terminated employment can be archived.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function rehireEmployee(
    event: FormEvent<HTMLFormElement>,
    employeeId: string,
    expectedVersion: number,
  ) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const form = new FormData(event.currentTarget);
    const manager = String(form.get('rehireManagerEmployeeId') || '');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/employees/${employeeId}/rehire`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
          },
          body: JSON.stringify({
            expectedVersion,
            joiningDate: form.get('rehireJoiningDate'),
            branchId: form.get('rehireBranchId'),
            departmentId: form.get('rehireDepartmentId'),
            designationId: form.get('rehireDesignationId'),
            managerEmployeeId: manager || null,
            ...(manager
              ? {}
              : { topLevelReason: form.get('rehireTopLevelReason') }),
            reason: form.get('rehireReason'),
          }),
        },
      );
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      await load(tenantId);
      setMessage(
        'Employee rehired with a new employment period and allocated seat. Login access remains revoked.',
      );
    } catch {
      setMessage(
        'Rehire was blocked. Check the new date, organization assignment and employee capacity.',
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
  const canReadCompensation = tenantRoles.some((role) =>
    ['payroll_preparer', 'payroll_approver'].includes(role),
  );
  const canWriteCompensation = tenantRoles.includes('payroll_preparer');
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">EMPLOYEE RECORDS</p>
          <h1>{companyName}</h1>
          <p className="subtitle">
            Monthly-salaried employee records, explicit seat-backed activation,
            scheduled separation, retained archives and effective organization
            history.
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
                  {!privateDetails[employee.id] ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void loadPrivateDetails(employee.id)}
                    >
                      Load restricted details
                    </button>
                  ) : (
                    <form
                      className="employee-activation"
                      onSubmit={(event) =>
                        savePrivateDetails(event, employee.id)
                      }
                    >
                      <p className="employee-schedule">
                        Restricted to owner/HR with recent MFA. Bank and salary
                        data are managed separately.
                      </p>
                      <label>
                        Personal email
                        <input
                          name="personalEmail"
                          type="email"
                          defaultValue={
                            privateDetails[employee.id].details
                              ?.personalEmail ?? ''
                          }
                        />
                      </label>
                      <label>
                        Mobile phone
                        <input
                          name="mobilePhone"
                          defaultValue={
                            privateDetails[employee.id].details?.mobilePhone ??
                            ''
                          }
                        />
                      </label>
                      <label>
                        Residential address
                        <textarea
                          name="residentialAddress"
                          maxLength={500}
                          defaultValue={
                            privateDetails[employee.id].details
                              ?.residentialAddress ?? ''
                          }
                        />
                      </label>
                      <label>
                        Emergency contact name
                        <input
                          name="emergencyContactName"
                          defaultValue={
                            privateDetails[employee.id].details
                              ?.emergencyContactName ?? ''
                          }
                        />
                      </label>
                      <label>
                        Emergency contact phone
                        <input
                          name="emergencyContactPhone"
                          defaultValue={
                            privateDetails[employee.id].details
                              ?.emergencyContactPhone ?? ''
                          }
                        />
                      </label>
                      <label>
                        CNIC
                        <input
                          name="cnic"
                          inputMode="numeric"
                          placeholder="35202-1234567-1"
                          defaultValue={
                            privateDetails[employee.id].details?.cnic ?? ''
                          }
                        />
                      </label>
                      <label>
                        Change reason
                        <input
                          name="privateDetailsReason"
                          required
                          minLength={3}
                          maxLength={240}
                        />
                      </label>
                      <button className="secondary-button" disabled={busy}>
                        {busy ? 'Saving…' : 'Save restricted details'}
                      </button>
                    </form>
                  )}
                  {canReadCompensation && !compensation[employee.id] && (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void loadCompensation(employee.id)}
                    >
                      Load compensation history
                    </button>
                  )}
                  {canReadCompensation && compensation[employee.id] && (
                    <div className="employee-activation">
                      <p className="employee-schedule">
                        PKR monthly compensation ·{' '}
                        {compensation[employee.id].agreement?.revisions
                          .length ?? 0}{' '}
                        revision(s)
                      </p>
                      {compensation[employee.id].agreement?.revisions.map(
                        (revision) => (
                          <p key={revision.revision}>
                            <strong>Revision {revision.revision}</strong> ·{' '}
                            {revision.effectiveFrom} to{' '}
                            {revision.effectiveTo ?? 'current'} ·{' '}
                            {revision.components
                              .map(
                                (component) =>
                                  `${component.name}: PKR ${component.monthlyAmount}`,
                              )
                              .join(' · ')}
                          </p>
                        ),
                      )}
                      {canWriteCompensation &&
                        employee.status !== 'terminated' &&
                        employee.status !== 'archived' && (
                          <form
                            className="employee-activation"
                            onSubmit={(event) =>
                              saveCompensation(event, employee.id)
                            }
                          >
                            {compensationDrafts[employee.id].map(
                              (component, index) => (
                                <fieldset key={`${component.code}-${index}`}>
                                  <legend>Salary component {index + 1}</legend>
                                  <label>
                                    Code
                                    <input
                                      value={component.code}
                                      required
                                      onChange={(event) =>
                                        updateCompensationDraft(
                                          employee.id,
                                          index,
                                          { code: event.target.value },
                                        )
                                      }
                                    />
                                  </label>
                                  <label>
                                    Name
                                    <input
                                      value={component.name}
                                      required
                                      onChange={(event) =>
                                        updateCompensationDraft(
                                          employee.id,
                                          index,
                                          { name: event.target.value },
                                        )
                                      }
                                    />
                                  </label>
                                  <label>
                                    Type
                                    <select
                                      value={component.kind}
                                      onChange={(event) =>
                                        updateCompensationDraft(
                                          employee.id,
                                          index,
                                          {
                                            kind: event.target
                                              .value as CompensationDraft['kind'],
                                          },
                                        )
                                      }
                                    >
                                      <option value="basic_salary">
                                        Basic salary
                                      </option>
                                      <option value="allowance">
                                        Allowance
                                      </option>
                                      <option value="deduction">
                                        Deduction
                                      </option>
                                    </select>
                                  </label>
                                  <label>
                                    Monthly amount (PKR)
                                    <input
                                      value={component.monthlyAmount}
                                      inputMode="decimal"
                                      required
                                      onChange={(event) =>
                                        updateCompensationDraft(
                                          employee.id,
                                          index,
                                          { monthlyAmount: event.target.value },
                                        )
                                      }
                                    />
                                  </label>
                                  {component.kind !== 'basic_salary' && (
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      onClick={() =>
                                        setCompensationDrafts((current) => ({
                                          ...current,
                                          [employee.id]: current[
                                            employee.id
                                          ].filter((_, item) => item !== index),
                                        }))
                                      }
                                    >
                                      Remove component
                                    </button>
                                  )}
                                </fieldset>
                              ),
                            )}
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() =>
                                setCompensationDrafts((current) => ({
                                  ...current,
                                  [employee.id]: [
                                    ...current[employee.id],
                                    {
                                      code: '',
                                      name: '',
                                      kind: 'allowance',
                                      monthlyAmount: '',
                                    },
                                  ],
                                }))
                              }
                            >
                              Add salary component
                            </button>
                            <label>
                              Effective from
                              <input
                                name="compensationEffectiveFrom"
                                type="date"
                                required
                              />
                            </label>
                            <label>
                              Compensation change reason
                              <input
                                name="compensationReason"
                                required
                                minLength={3}
                                maxLength={240}
                              />
                            </label>
                            <button
                              className="secondary-button"
                              disabled={busy}
                            >
                              {busy ? 'Saving…' : 'Save compensation revision'}
                            </button>
                          </form>
                        )}
                    </div>
                  )}
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
                  {employee.status === 'active' &&
                    (employee.finalWorkingDate ? (
                      <p className="employee-schedule">
                        Final working date: {employee.finalWorkingDate}. Access
                        ends after this date.
                      </p>
                    ) : (
                      <form
                        className="employee-activation"
                        onSubmit={(event) =>
                          scheduleTermination(
                            event,
                            employee.id,
                            employee.version,
                          )
                        }
                      >
                        <label>
                          Final working date for {employee.name}
                          <input
                            name="finalWorkingDate"
                            type="date"
                            min={todayInKarachi()}
                            required
                          />
                        </label>
                        <label>
                          Termination reason for {employee.name}
                          <input
                            name="terminationReason"
                            required
                            minLength={3}
                            maxLength={240}
                          />
                        </label>
                        <button className="secondary-button" disabled={busy}>
                          {busy ? 'Scheduling…' : 'Schedule termination'}
                        </button>
                      </form>
                    ))}
                  {employee.status === 'terminated' && (
                    <form
                      className="employee-activation"
                      onSubmit={(event) =>
                        archiveEmployee(event, employee.id, employee.version)
                      }
                    >
                      <label>
                        Archive reason for {employee.name}
                        <input
                          name="archiveReason"
                          required
                          minLength={3}
                          maxLength={240}
                        />
                      </label>
                      <button className="secondary-button" disabled={busy}>
                        {busy ? 'Archiving…' : 'Archive employee'}
                      </button>
                    </form>
                  )}
                  {employee.status === 'archived' && (
                    <>
                      {employee.archivedAt && (
                        <p className="employee-schedule">
                          Archived{' '}
                          {new Date(employee.archivedAt).toLocaleDateString()}.
                          Employment history is retained.
                        </p>
                      )}
                      <form
                        className="employee-activation"
                        onSubmit={(event) =>
                          rehireEmployee(event, employee.id, employee.version)
                        }
                      >
                        <label>
                          New joining date for {employee.name}
                          <input
                            name="rehireJoiningDate"
                            type="date"
                            min={todayInKarachi()}
                            required
                          />
                        </label>
                        <label>
                          Branch
                          <select name="rehireBranchId" required>
                            {organization.branches
                              .filter(({ status }) => status === 'active')
                              .map((branch) => (
                                <option key={branch.id} value={branch.id}>
                                  {branch.code} · {branch.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          Department
                          <select name="rehireDepartmentId" required>
                            {organization.departments
                              .filter(({ status }) => status === 'active')
                              .map((department) => (
                                <option
                                  key={department.id}
                                  value={department.id}
                                >
                                  {department.code} · {department.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          Designation
                          <select name="rehireDesignationId" required>
                            {organization.designations
                              .filter(({ status }) => status === 'active')
                              .map((designation) => (
                                <option
                                  key={designation.id}
                                  value={designation.id}
                                >
                                  {designation.code} · {designation.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          Manager
                          <select
                            name="rehireManagerEmployeeId"
                            value={rehireManagers[employee.id] || ''}
                            onChange={(event) =>
                              setRehireManagers((current) => ({
                                ...current,
                                [employee.id]: event.target.value,
                              }))
                            }
                          >
                            <option value="">No manager</option>
                            {roster.employees
                              .filter(
                                (candidate) =>
                                  candidate.status === 'active' &&
                                  candidate.id !== employee.id,
                              )
                              .map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                  {candidate.employeeNumber} · {candidate.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        {!rehireManagers[employee.id] && (
                          <label>
                            Top-level reporting reason
                            <input
                              name="rehireTopLevelReason"
                              required
                              minLength={3}
                              maxLength={240}
                            />
                          </label>
                        )}
                        <label>
                          Rehire reason
                          <input
                            name="rehireReason"
                            required
                            minLength={3}
                            maxLength={240}
                          />
                        </label>
                        <button className="secondary-button" disabled={busy}>
                          {busy ? 'Rehiring…' : 'Rehire employee'}
                        </button>
                      </form>
                    </>
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
        Employee numbers are unique inside this company. Restricted contact,
        emergency, address and CNIC details load only on request. Salary and
        bank details remain unavailable in this workflow.
      </p>
    </>
  );
}
