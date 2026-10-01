'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  administrativeTenantRoleSchema,
  membershipAdministrationListSchema,
  membershipAdministrationResultSchema,
  membershipRevocationSchema,
  membershipRoleUpdateSchema,
  type MembershipAdministration,
} from '@kinto/contracts';

type ViewState =
  'loading' | 'ready' | 'select-company' | 'signed-out' | 'denied' | 'error';
type Role = (typeof administrativeTenantRoleSchema.options)[number];
const roles = administrativeTenantRoleSchema.options;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const label = (value: string) => value.replaceAll('_', ' ');

export default function Members() {
  const [state, setState] = useState<ViewState>('loading');
  const [tenantId, setTenantId] = useState('');
  const [csrf, setCsrf] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [members, setMembers] = useState<MembershipAdministration[]>([]);
  const [editing, setEditing] = useState<MembershipAdministration | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<Role[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [message, setMessage] = useState('');

  async function load(selectedTenant: string, signal?: AbortSignal) {
    const response = await fetch(
      `/api/v1/tenants/${selectedTenant}/memberships`,
      { cache: 'no-store', signal },
    );
    if (response.status === 401 || response.status === 403) {
      setMembers([]);
      setEditing(null);
      setState(response.status === 401 ? 'signed-out' : 'denied');
      return false;
    }
    if (!response.ok) throw new Error('Unavailable');
    setMembers(
      membershipAdministrationListSchema.parse(await response.json())
        .memberships,
    );
    setNeedsRefresh(false);
    return true;
  }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/v1/auth/session', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 404)
          return setState('signed-out');
        if (!response.ok) throw new Error('Unavailable');
        const session: unknown = await response.json();
        if (
          !session ||
          typeof session !== 'object' ||
          !('csrfToken' in session) ||
          typeof session.csrfToken !== 'string' ||
          !('selectedTenantId' in session) ||
          !('tenants' in session) ||
          !Array.isArray(session.tenants)
        )
          throw new Error('Invalid session');
        if (session.selectedTenantId === null)
          return setState('select-company');
        if (
          typeof session.selectedTenantId !== 'string' ||
          !uuid.test(session.selectedTenantId)
        )
          throw new Error('Invalid tenant');
        const tenant = session.tenants.find(
          (candidate: unknown) =>
            !!candidate &&
            typeof candidate === 'object' &&
            'id' in candidate &&
            candidate.id === session.selectedTenantId &&
            'name' in candidate &&
            typeof candidate.name === 'string' &&
            'roles' in candidate &&
            Array.isArray(candidate.roles),
        );
        if (!tenant || !('name' in tenant) || !('roles' in tenant))
          throw new Error('Invalid company');
        if (!(tenant.roles as unknown[]).includes('owner'))
          return setState('denied');
        if (!(await load(session.selectedTenantId, controller.signal))) return;
        setTenantId(session.selectedTenantId);
        setCompanyName(tenant.name as string);
        setCsrf(session.csrfToken);
        setState('ready');
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    })();
    return () => controller.abort();
  }, []);

  async function refresh() {
    setBusy(true);
    setMessage('');
    setEditing(null);
    try {
      await load(tenantId);
    } catch {
      setState('error');
    } finally {
      setBusy(false);
    }
  }

  async function mutate(revoke: boolean) {
    if (
      !editing ||
      editing.employeeId !== null ||
      editing.roles.includes('employee') ||
      editing.status !== 'active'
    )
      return;
    const input = revoke
      ? membershipRevocationSchema.safeParse({
          expectedVersion: editing.version,
          reason,
        })
      : membershipRoleUpdateSchema.safeParse({
          expectedVersion: editing.version,
          roles: selectedRoles,
          reason,
        });
    if (!input.success) {
      setMessage(
        'Choose at least one administrative role and provide a reason of 3–240 characters.',
      );
      return;
    }
    if (
      revoke &&
      !window.confirm(
        'Revoke this administrative membership? Access cannot be restored from this screen.',
      )
    )
      return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/memberships/${editing.id}/${revoke ? 'revocation' : 'roles'}`,
        {
          method: revoke ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify(input.data),
        },
      );
      if (response.status === 401 || response.status === 403) {
        setMembers([]);
        setEditing(null);
        return setState(response.status === 401 ? 'signed-out' : 'denied');
      }
      if (response.status === 409) {
        setEditing(null);
        if (await load(tenantId))
          setMessage(
            'Change refused: the membership changed, is protected, or the change would remove the last active owner. Review the refreshed list.',
          );
        return;
      }
      if (!response.ok) throw new Error('Unavailable');
      const result = membershipAdministrationResultSchema.parse(
        await response.json(),
      );
      if (result.id !== editing.id) throw new Error('Invalid result');
      setEditing(null);
      if (await load(tenantId))
        setMessage(
          revoke
            ? 'Administrative access revoked with an audit record.'
            : 'Administrative roles updated with an audit record.',
        );
    } catch {
      // The command may have committed even if its response was lost.
      setEditing(null);
      setNeedsRefresh(true);
      setMessage(
        'The change could not be confirmed. Refresh memberships before trying again.',
      );
    } finally {
      setBusy(false);
    }
  }

  function edit(member: MembershipAdministration) {
    setEditing(member);
    setSelectedRoles(roles.filter((role) => member.roles.includes(role)));
    setReason('');
    setMessage('');
  }

  if (state !== 'ready')
    return (
      <p className="notice">
        {
          {
            loading: 'Loading company memberships…',
            'select-company':
              'Choose a company workspace before managing access.',
            'signed-out': 'Sign in to manage company access.',
            denied:
              'Only a company owner with recent verification can manage memberships. Sign in again if verification has expired.',
            error:
              'Membership administration is unavailable. Refresh and try again.',
          }[state]
        }
      </p>
    );

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MEMBERS & ACCESS</p>
          <h1>{companyName}</h1>
          <p className="subtitle">
            Review company access and manage existing administrative
            memberships.
          </p>
        </div>
      </div>
      <section className="settings-card" aria-label="Company memberships">
        <h2>Company memberships</h2>
        <p>
          Identity IDs are shown instead of private provider details.
          Employee-linked access is managed through employee lifecycle
          workflows. The server protects the last active owner. Revoked
          administrative access cannot be restored here.
        </p>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh memberships
        </button>
        {message && <p role="status">{message}</p>}
        {members.length === 0 ? (
          <p>No memberships are available.</p>
        ) : (
          <ul className="document-list">
            {members.map((member) => {
              const protectedEmployee =
                member.employeeId !== null || member.roles.includes('employee');
              return (
                <li key={member.id}>
                  <div className="document-summary">
                    <div>
                      <strong>{member.identityId}</strong>
                      <small>
                        Membership {member.id} · version {member.version}
                      </small>
                    </div>
                    <span>
                      {member.status} · {member.roles.map(label).join(', ')}
                    </span>
                  </div>
                  {protectedEmployee ? (
                    <p>Employee access: use employee lifecycle controls.</p>
                  ) : member.status === 'active' ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || needsRefresh}
                      onClick={() => edit(member)}
                      aria-label={`Manage membership ${member.id}`}
                    >
                      Manage access
                    </button>
                  ) : (
                    <p>Revoked access is retained for audit history.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {editing && (
        <section
          className="settings-card"
          aria-label="Edit administrative access"
        >
          <h2>Edit administrative access</h2>
          <p className="document-removal">
            Membership {editing.id} · expected version {editing.version}
          </p>
          <form
            className="settings-form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void mutate(false);
            }}
          >
            <fieldset className="membership-roles" disabled={busy}>
              <legend>Administrative roles</legend>
              {roles.map((role) => (
                <label key={role}>
                  <input
                    type="checkbox"
                    checked={selectedRoles.includes(role)}
                    onChange={(event) =>
                      setSelectedRoles((current) =>
                        event.target.checked
                          ? [...current, role]
                          : current.filter((value) => value !== role),
                      )
                    }
                  />
                  {label(role)}
                </label>
              ))}
            </fieldset>
            <label>
              Audit reason
              <input
                value={reason}
                minLength={3}
                maxLength={240}
                required
                disabled={busy}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <div className="document-actions">
              <button
                className="primary-button"
                disabled={
                  busy || selectedRoles.length === 0 || reason.trim().length < 3
                }
                type="submit"
              >
                Save roles
              </button>
              <button
                className="secondary-button"
                disabled={busy || reason.trim().length < 3}
                type="button"
                onClick={() => void mutate(true)}
              >
                Revoke administrative access
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                type="button"
                onClick={() => setEditing(null)}
              >
                Cancel editing
              </button>
            </div>
          </form>
        </section>
      )}
    </>
  );
}
