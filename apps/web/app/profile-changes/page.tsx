'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import {
  employeeProfileChangeRequestListSchema,
  employeeProfileChangeRequestReviewListSchema,
  employeeSelfProfileSchema,
  type EmployeeProfileChangeRequestList,
  type EmployeeProfileChangeRequestReview,
  type EmployeeSelfProfile,
} from '@kinto/contracts';

type ViewState =
  'loading' | 'ready' | 'select-company' | 'signed-out' | 'denied' | 'error';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en-PK', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
const display = (value: string | null) => value || 'Not supplied';

export default function ProfileChanges() {
  const [state, setState] = useState<ViewState>('loading');
  const [tenantId, setTenantId] = useState('');
  const [csrf, setCsrf] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [canSelfService, setCanSelfService] = useState(false);
  const [canReview, setCanReview] = useState(false);
  const [profile, setProfile] = useState<EmployeeSelfProfile | null>(null);
  const [ownRequests, setOwnRequests] =
    useState<EmployeeProfileChangeRequestList>({ requests: [] });
  const [reviewRequests, setReviewRequests] = useState<
    EmployeeProfileChangeRequestReview[]
  >([]);
  const [personalEmail, setPersonalEmail] = useState('');
  const [mobilePhone, setMobilePhone] = useState('');
  const [emergencyName, setEmergencyName] = useState('');
  const [emergencyPhone, setEmergencyPhone] = useState('');
  const [requestReason, setRequestReason] = useState('');
  const [decisionReasons, setDecisionReasons] = useState<
    Record<string, string>
  >({});
  const [submissionKey, setSubmissionKey] = useState('');
  const [decisionKeys, setDecisionKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function loadSelf(selectedTenantId: string) {
    const [profileResponse, requestsResponse] = await Promise.all([
      fetch(`/api/v1/tenants/${selectedTenantId}/me/profile`, {
        cache: 'no-store',
      }),
      fetch(`/api/v1/tenants/${selectedTenantId}/me/profile-change-requests`, {
        cache: 'no-store',
      }),
    ]);
    if (profileResponse.status === 401 || requestsResponse.status === 401) {
      setState('signed-out');
      return false;
    }
    if (profileResponse.status === 403 || requestsResponse.status === 403) {
      setState('denied');
      return false;
    }
    if (!profileResponse.ok || !requestsResponse.ok)
      throw new Error('Unavailable');
    const nextProfile = employeeSelfProfileSchema.parse(
      await profileResponse.json(),
    );
    const requests = employeeProfileChangeRequestListSchema.parse(
      await requestsResponse.json(),
    );
    setProfile(nextProfile);
    setOwnRequests(requests);
    setPersonalEmail(nextProfile.contact?.personalEmail ?? '');
    setMobilePhone(nextProfile.contact?.mobilePhone ?? '');
    setEmergencyName(nextProfile.contact?.emergencyContactName ?? '');
    setEmergencyPhone(nextProfile.contact?.emergencyContactPhone ?? '');
    return true;
  }

  async function loadReviews(selectedTenantId: string) {
    const response = await fetch(
      `/api/v1/tenants/${selectedTenantId}/profile-change-requests`,
      { cache: 'no-store' },
    );
    if (response.status === 401) {
      setState('signed-out');
      return false;
    }
    if (response.status === 403) {
      setState('denied');
      return false;
    }
    if (!response.ok) throw new Error('Unavailable');
    const data = employeeProfileChangeRequestReviewListSchema.parse(
      await response.json(),
    );
    setReviewRequests(data.requests);
    return true;
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
            typeof candidate.name === 'string' &&
            'roles' in candidate &&
            Array.isArray(candidate.roles),
        );
        if (!tenant || !('name' in tenant) || !('roles' in tenant))
          throw new Error('Invalid company');
        const roles = (tenant.roles as unknown[]).filter(
          (role: unknown): role is string => typeof role === 'string',
        );
        const employee = roles.includes('employee');
        const reviewer = roles.some((role) =>
          ['owner', 'hr_admin'].includes(role),
        );
        if (!employee && !reviewer) return setState('denied');
        setTenantId(data.selectedTenantId);
        setCsrf(data.csrfToken);
        setCompanyName(String(tenant.name));
        setCanSelfService(employee);
        setCanReview(reviewer);
        const loaded = await Promise.all([
          employee ? loadSelf(data.selectedTenantId) : Promise.resolve(true),
          reviewer ? loadReviews(data.selectedTenantId) : Promise.resolve(true),
        ]);
        if (loaded.includes(false)) return;
        setState('ready');
      } catch {
        setState('error');
      }
    })();
  }, []);

  async function submitRequest(event: FormEvent) {
    event.preventDefault();
    if (!profile) return;
    setBusy(true);
    setMessage('');
    const idempotencyKey = submissionKey || crypto.randomUUID();
    if (!submissionKey) setSubmissionKey(idempotencyKey);
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/me/profile-change-requests`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            expectedContactVersion: profile.contact?.version ?? 0,
            personalEmail: personalEmail.trim().toLowerCase() || null,
            mobilePhone: mobilePhone.trim() || null,
            emergencyContactName: emergencyName.trim() || null,
            emergencyContactPhone: emergencyPhone.trim() || null,
            reason: requestReason,
          }),
        },
      );
      if (response.status === 401) return setState('signed-out');
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      await loadSelf(tenantId);
      setSubmissionKey('');
      setRequestReason('');
      setMessage('Your contact change request is waiting for HR review.');
    } catch {
      setMessage(
        'The request could not be submitted. Refresh to check the current profile and pending requests.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function decide(
    request: EmployeeProfileChangeRequestReview,
    decision: 'approved' | 'rejected',
  ) {
    const reason = decisionReasons[request.id]?.trim() ?? '';
    if (reason.length < 3) return;
    setBusy(true);
    setMessage('');
    const idempotencyKey = decisionKeys[request.id] || crypto.randomUUID();
    if (!decisionKeys[request.id])
      setDecisionKeys((current) => ({
        ...current,
        [request.id]: idempotencyKey,
      }));
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/profile-change-requests/${request.id}/decision`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            expectedVersion: request.version,
            decision,
            reason,
          }),
        },
      );
      if (response.status === 401) return setState('signed-out');
      if (response.status === 403) return setState('denied');
      if (!response.ok) throw new Error('Request failed');
      await loadReviews(tenantId);
      setDecisionReasons((current) => ({ ...current, [request.id]: '' }));
      setDecisionKeys((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setMessage(`Request ${decision}.`);
    } catch {
      setMessage(
        'The decision could not be saved. Refresh in case the request or approved profile changed.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (state !== 'ready') {
    const copy = {
      loading: 'Loading profile changes…',
      ready: '',
      'select-company': 'Choose a company workspace before opening profiles.',
      'signed-out': 'Sign in to open profile changes.',
      denied:
        'Employee self-service or owner/HR access with recent multi-factor authentication is required.',
      error: 'Profile changes are unavailable. Refresh and try again.',
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

  const pendingOwnRequest = ownRequests.requests.find(
    ({ status }) => status === 'pending',
  );
  const pendingReviews = reviewRequests.filter(
    ({ status }) => status === 'pending',
  ).length;
  const emergencyPairValid =
    Boolean(emergencyName.trim()) === Boolean(emergencyPhone.trim());
  const proposalChanged = profile
    ? (profile.contact?.personalEmail ?? '') !==
        personalEmail.trim().toLowerCase() ||
      (profile.contact?.mobilePhone ?? '') !== mobilePhone.trim() ||
      (profile.contact?.emergencyContactName ?? '') !== emergencyName.trim() ||
      (profile.contact?.emergencyContactPhone ?? '') !== emergencyPhone.trim()
    : false;
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROFILE CHANGE WORKSPACE</p>
          <h1>{companyName}</h1>
          <p className="subtitle">
            Employees propose contact updates. HR verifies each request before
            approved details change.
          </p>
        </div>
      </div>

      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}

      {canSelfService && profile && (
        <div className="profile-change-grid">
          <section className="settings-card" aria-labelledby="profile-heading">
            <div className="section-heading">
              <h2 id="profile-heading">Your approved profile</h2>
              <span>{profile.employee.employeeNumber}</span>
            </div>
            <h3 className="profile-name">{profile.employee.name}</h3>
            <dl className="profile-details">
              <div>
                <dt>Personal email</dt>
                <dd>{display(profile.contact?.personalEmail ?? null)}</dd>
              </div>
              <div>
                <dt>Mobile phone</dt>
                <dd>{display(profile.contact?.mobilePhone ?? null)}</dd>
              </div>
              <div>
                <dt>Emergency contact</dt>
                <dd>
                  {display(profile.contact?.emergencyContactName ?? null)}
                  {profile.contact?.emergencyContactPhone
                    ? ` · ${profile.contact.emergencyContactPhone}`
                    : ''}
                </dd>
              </div>
            </dl>
            <p className="audit-note">
              Salary, CNIC, address, role, manager and employment status cannot
              be changed here.
            </p>
          </section>

          <section className="settings-card" aria-labelledby="request-heading">
            <div className="section-heading">
              <h2 id="request-heading">Request a contact change</h2>
              <span>HR approval required</span>
            </div>
            {pendingOwnRequest ? (
              <p className="empty-state">
                A request submitted {formatDate(pendingOwnRequest.createdAt)} is
                already waiting for review.
              </p>
            ) : (
              <form className="settings-form" onSubmit={submitRequest}>
                <label>
                  Personal email
                  <input
                    type="email"
                    value={personalEmail}
                    onChange={(event) => setPersonalEmail(event.target.value)}
                  />
                </label>
                <label>
                  Mobile phone
                  <input
                    inputMode="tel"
                    pattern="\+?[0-9]{7,15}"
                    value={mobilePhone}
                    onChange={(event) => setMobilePhone(event.target.value)}
                  />
                </label>
                <label>
                  Emergency contact name
                  <input
                    maxLength={160}
                    value={emergencyName}
                    onChange={(event) => setEmergencyName(event.target.value)}
                  />
                </label>
                <label>
                  Emergency contact phone
                  <input
                    inputMode="tel"
                    pattern="\+?[0-9]{7,15}"
                    value={emergencyPhone}
                    onChange={(event) => setEmergencyPhone(event.target.value)}
                  />
                </label>
                <label>
                  Reason
                  <textarea
                    minLength={3}
                    maxLength={240}
                    required
                    value={requestReason}
                    onChange={(event) => setRequestReason(event.target.value)}
                  />
                </label>
                <button
                  className="primary-button"
                  disabled={busy || !emergencyPairValid || !proposalChanged}
                >
                  {busy ? 'Submitting…' : 'Send request'}
                </button>
              </form>
            )}
          </section>

          <section
            className="settings-card profile-history"
            aria-labelledby="history-heading"
          >
            <div className="section-heading">
              <h2 id="history-heading">Your request history</h2>
              <span>{ownRequests.requests.length} requests</span>
            </div>
            {ownRequests.requests.length === 0 ? (
              <p className="empty-state">No contact change requests yet.</p>
            ) : (
              <ol className="change-request-list">
                {ownRequests.requests.map((request) => (
                  <li key={request.id}>
                    <div className="employee-summary">
                      <strong>{formatDate(request.createdAt)}</strong>
                      <span className={`request-status ${request.status}`}>
                        {request.status}
                      </span>
                    </div>
                    <p>{request.reason}</p>
                    {request.decisionReason && (
                      <small>HR: {request.decisionReason}</small>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}

      {canReview && (
        <section className="settings-card" aria-labelledby="review-heading">
          <div className="section-heading">
            <h2 id="review-heading">HR review queue</h2>
            <span>{pendingReviews} pending</span>
          </div>
          {reviewRequests.length === 0 ? (
            <p className="empty-state">No profile change requests.</p>
          ) : (
            <ol className="change-request-list review-list">
              {reviewRequests.map((request) => (
                <li key={request.id}>
                  <div className="employee-summary">
                    <div>
                      <strong>{request.employeeName}</strong>
                      <small>
                        {request.employeeNumber} ·{' '}
                        {formatDate(request.createdAt)}
                      </small>
                    </div>
                    <span className={`request-status ${request.status}`}>
                      {request.status}
                    </span>
                  </div>
                  <p className="request-reason">{request.reason}</p>
                  <dl className="profile-details proposed-details">
                    <div>
                      <dt>Email</dt>
                      <dd>{display(request.personalEmail)}</dd>
                    </div>
                    <div>
                      <dt>Mobile</dt>
                      <dd>{display(request.mobilePhone)}</dd>
                    </div>
                    <div>
                      <dt>Emergency contact</dt>
                      <dd>
                        {display(request.emergencyContactName)}
                        {request.emergencyContactPhone
                          ? ` · ${request.emergencyContactPhone}`
                          : ''}
                      </dd>
                    </div>
                  </dl>
                  {request.status === 'pending' ? (
                    <div className="decision-controls">
                      <label>
                        Decision reason
                        <input
                          maxLength={240}
                          value={decisionReasons[request.id] ?? ''}
                          onChange={(event) =>
                            setDecisionReasons((current) => ({
                              ...current,
                              [request.id]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={
                          busy ||
                          (decisionReasons[request.id]?.trim().length ?? 0) < 3
                        }
                        onClick={() => void decide(request, 'approved')}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          busy ||
                          (decisionReasons[request.id]?.trim().length ?? 0) < 3
                        }
                        onClick={() => void decide(request, 'rejected')}
                      >
                        Reject
                      </button>
                    </div>
                  ) : (
                    <small>
                      {request.decisionReason}
                      {request.decidedAt
                        ? ` · ${formatDate(request.decidedAt)}`
                        : ''}
                    </small>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </>
  );
}
