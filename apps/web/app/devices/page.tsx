'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  deviceCreateSchema,
  deviceUpdateSchema,
  deviceInventorySchema,
  organizationSnapshotSchema,
} from '@kinto/contracts';

type Device = ReturnType<typeof deviceInventorySchema.parse>['items'][number];
type Branch = ReturnType<
  typeof organizationSnapshotSchema.parse
>['branches'][number];
type State =
  'loading' | 'ready' | 'signed-out' | 'select-company' | 'denied' | 'error';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function Devices() {
  const [state, setState] = useState<State>('loading');
  const [tenantId, setTenantId] = useState('');
  const [company, setCompany] = useState('');
  const [csrf, setCsrf] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [items, setItems] = useState<Device[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [afterId, setAfterId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Device | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [firmware, setFirmware] = useState('');
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [message, setMessage] = useState('');

  function resetForm() {
    setEditing(null);
    setName('');
    setCode('');
    setFirmware('');
    setBranchId('');
  }
  function clear(view: State) {
    resetForm();
    setItems([]);
    setBranches([]);
    setNextCursor(null);
    setAfterId(null);
    setTenantId('');
    setCompany('');
    setCsrf('');
    setCanManage(false);
    setMessage('');
    setState(view);
  }
  async function load(
    selected: string,
    cursor: string | null,
    signal?: AbortSignal,
  ) {
    const suffix = cursor ? `&afterId=${encodeURIComponent(cursor)}` : '';
    const [inventory, organization] = await Promise.all([
      fetch(`/api/v1/tenants/${selected}/devices?limit=25${suffix}`, {
        cache: 'no-store',
        signal,
      }),
      fetch(`/api/v1/tenants/${selected}/organization`, {
        cache: 'no-store',
        signal,
      }),
    ]);
    if (signal?.aborted) return false;
    if ([inventory, organization].some((response) => response.status === 401)) {
      clear('signed-out');
      return false;
    }
    if ([inventory, organization].some((response) => response.status === 403)) {
      clear('denied');
      return false;
    }
    if (!inventory.ok || !organization.ok) throw new Error('Unavailable');
    const [rawDevices, rawOrganization] = await Promise.all([
      inventory.json(),
      organization.json(),
    ]);
    if (signal?.aborted) return false;
    const data = deviceInventorySchema.parse(rawDevices);
    const org = organizationSnapshotSchema.parse(rawOrganization);
    // A cursor must advance exactly past the last item of an ordered bounded page.
    if (
      data.items.length > 25 ||
      data.items.some(
        (item, index) =>
          (cursor !== null && item.id <= cursor) ||
          (index > 0 && item.id <= data.items[index - 1].id),
      ) ||
      (data.nextCursor !== null && data.nextCursor !== data.items.at(-1)?.id)
    )
      throw new Error('Invalid page');
    setItems(data.items);
    setBranches(org.branches);
    setNextCursor(data.nextCursor);
    setAfterId(cursor);
    setNeedsRefresh(false);
    setState('ready');
    return true;
  }
  async function initialize(signal?: AbortSignal) {
    const response = await fetch('/api/v1/auth/session', {
      cache: 'no-store',
      signal,
    });
    if (signal?.aborted) return;
    if (response.status === 401 || response.status === 404)
      return clear('signed-out');
    if (!response.ok) throw new Error('Unavailable');
    const session: unknown = await response.json();
    if (
      !session ||
      typeof session !== 'object' ||
      !('selectedTenantId' in session) ||
      !('csrfToken' in session) ||
      typeof session.csrfToken !== 'string' ||
      !('tenants' in session) ||
      !Array.isArray(session.tenants)
    )
      throw new Error('Invalid session');
    if (session.selectedTenantId === null) return clear('select-company');
    if (
      typeof session.selectedTenantId !== 'string' ||
      !uuid.test(session.selectedTenantId)
    )
      throw new Error('Invalid tenant');
    const tenant = session.tenants.find(
      (value: unknown) =>
        value &&
        typeof value === 'object' &&
        'id' in value &&
        value.id === session.selectedTenantId &&
        'name' in value &&
        typeof value.name === 'string' &&
        'roles' in value &&
        Array.isArray(value.roles),
    );
    if (!tenant) throw new Error('Invalid company');
    if (!tenant.roles.includes('owner') && !tenant.roles.includes('hr_admin'))
      return clear('denied');
    if (await load(session.selectedTenantId, null, signal)) {
      setTenantId(session.selectedTenantId);
      setCompany(tenant.name);
      setCsrf(session.csrfToken);
      setCanManage(tenant.roles.includes('owner'));
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void initialize(controller.signal).catch(() => {
      if (!controller.signal.aborted) clear('error');
    });
    return () => controller.abort();
    // Initialization runs once per mounted company workspace; refresh rechecks the session.
  }, []);

  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    resetForm();
    setMessage('');
    // Discard previous company data before rechecking current session selection/roles.
    clear('loading');
    try {
      await initialize();
    } catch {
      clear('error');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function page(cursor: string | null) {
    if (inFlight.current || needsRefresh) return;
    inFlight.current = true;
    setBusy(true);
    resetForm();
    setMessage('');
    try {
      await load(tenantId, cursor);
    } catch {
      clear('error');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function mutate(retiring: Device | null = null) {
    if (inFlight.current || !canManage || needsRefresh || state !== 'ready')
      return;
    const target = retiring ?? editing;
    const metadata = retiring
      ? {
          branchId: retiring.branchId,
          name: retiring.name,
          model: retiring.model,
          firmware: retiring.firmware,
          sourceTimezone: retiring.sourceTimezone,
        }
      : {
          branchId,
          name,
          model: 'ZKTeco_K50',
          firmware: firmware || null,
          sourceTimezone: 'Asia/Karachi',
        };
    const parsed = target
      ? deviceUpdateSchema.safeParse({
          ...metadata,
          expectedVersion: target.version,
          status: retiring ? 'retired' : 'draft',
          reason: retiring ? 'retire_device' : 'metadata_correction',
        })
      : deviceCreateSchema.safeParse({
          ...metadata,
          code,
          reason: 'initial_setup',
        });
    if (
      !parsed.success ||
      (!retiring &&
        !branches.some(
          (branch) => branch.id === branchId && branch.status === 'active',
        ))
    ) {
      setMessage(
        'Choose an active branch and supply a name, an uppercase device code and a valid firmware label (or leave firmware blank).',
      );
      return;
    }
    if (
      retiring &&
      !window.confirm(
        `Retire ${retiring.code}? Its history and code will be retained. This cannot be undone here.`,
      )
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(
        `/api/v1/tenants/${tenantId}/devices${target ? `/${target.id}` : ''}`,
        {
          method: target ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify(parsed.data),
        },
      );
      resetForm();
      if (response.status === 401 || response.status === 403)
        return clear(response.status === 401 ? 'signed-out' : 'denied');
      if (response.status === 409 || response.status === 404) {
        setNeedsRefresh(true);
        setMessage(
          'Change refused: the record, branch or version may have changed, or the code is already reserved. Refresh inventory before trying again.',
        );
        return;
      }
      if (!response.ok) throw new Error('Unavailable');
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== 'object' ||
        !('id' in result) ||
        typeof result.id !== 'string' ||
        !uuid.test(result.id) ||
        !('version' in result) ||
        !Number.isSafeInteger(result.version) ||
        (target
          ? result.id !== target.id || result.version !== target.version + 1
          : result.version !== 1)
      )
        throw new Error('Invalid result');
      if (await load(tenantId, null))
        setMessage(
          retiring
            ? 'Device retired; history retained.'
            : target
              ? 'Draft metadata updated.'
              : 'Draft device registered. This does not connect or activate the device.',
        );
    } catch {
      resetForm();
      setNeedsRefresh(true);
      setMessage(
        'The change could not be confirmed and may have committed. Refresh inventory before trying again.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function edit(item: Device) {
    if (busy || needsRefresh || !canManage || item.status !== 'draft') return;
    setEditing(item);
    setName(item.name);
    setCode(item.code);
    setFirmware(item.firmware ?? '');
    setBranchId(item.branchId);
    setMessage('');
  }
  const activeBranches = branches.filter(
    (branch) => branch.status === 'active',
  );
  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">PHASE 2 · DRAFT INVENTORY</span>
          <h1>Attendance devices.</h1>
          <p>
            Prepare your company's K50 inventory. Registration does not connect
            a device or enable attendance uploads.
          </p>
        </div>
      </section>
      <section
        className="settings-card device-workspace"
        aria-label="Device inventory"
      >
        <h2>
          {company ? `${company} · device inventory` : 'Device inventory'}
        </h2>
        <p>
          Recent MFA is required. Owners manage draft records; HR has read-only
          access. No approved adapter, verified source identity or live
          attendance sync exists yet.
        </p>
        <p role="status">
          {state === 'loading'
            ? 'Loading device inventory…'
            : state === 'signed-out'
              ? 'Sign in to view device inventory.'
              : state === 'select-company'
                ? 'Select a company before viewing device inventory.'
                : state === 'denied'
                  ? 'Device inventory access denied. Owner or HR access and recent MFA are required.'
                  : state === 'error'
                    ? 'Device inventory is unavailable. Refresh to try again.'
                    : message ||
                      (canManage
                        ? 'Owner access · draft inventory only.'
                        : 'HR access · read only.')}
        </p>
        <div className="device-controls">
          <button
            className="secondary-button"
            disabled={busy || state === 'loading'}
            onClick={() => void refresh()}
          >
            Refresh inventory
          </button>
          {(state === 'signed-out' || state === 'select-company') && (
            <Link href="/login">Account access</Link>
          )}
        </div>
        {state === 'ready' && (
          <>
            {items.length === 0 ? (
              <p>No device records on this page.</p>
            ) : (
              <ul className="document-list">
                {items.map((item) => (
                  <li key={item.id}>
                    <div className="document-summary">
                      <div>
                        <strong>
                          {item.code} · {item.name}
                        </strong>
                        <small>
                          Branch:{' '}
                          {branches.find(
                            (branch) => branch.id === item.branchId,
                          )?.name ?? item.branchId}
                        </small>
                        <small>
                          ZKTeco K50 · {item.sourceTimezone} · firmware:{' '}
                          {item.firmware ?? 'not recorded'}
                        </small>
                      </div>
                      <span>
                        {item.status} · version {item.version}
                      </span>
                    </div>
                    <p>
                      Not connected · source identity unverified · no approved
                      adapter · never synced
                    </p>
                    {item.status === 'retired' ? (
                      <p>
                        Retired history is retained; its code cannot be reused.
                      </p>
                    ) : (
                      canManage && (
                        <div className="device-controls">
                          <button
                            className="secondary-button"
                            disabled={busy || needsRefresh}
                            onClick={() => edit(item)}
                            aria-label={`Edit ${item.code}`}
                          >
                            Edit metadata
                          </button>
                          <button
                            className="secondary-button"
                            disabled={busy || needsRefresh}
                            onClick={() => void mutate(item)}
                            aria-label={`Retire ${item.code}`}
                          >
                            Retire device
                          </button>
                        </div>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="device-controls">
              <button
                className="secondary-button"
                disabled={busy || needsRefresh || afterId === null}
                onClick={() => void page(null)}
              >
                First page
              </button>
              <button
                className="secondary-button"
                disabled={busy || needsRefresh || nextCursor === null}
                onClick={() => nextCursor && void page(nextCursor)}
              >
                Next page
              </button>
            </div>
          </>
        )}
      </section>
      {state === 'ready' && canManage && (
        <section
          className="settings-card device-workspace"
          aria-label="Device registration"
        >
          <h2>
            {editing ? `Edit ${editing.code}` : 'Register a draft device'}
          </h2>
          <p>
            Codes are permanent within this company. Device passwords, local
            connection settings and biometric templates must not be entered
            here. Firmware labels do not prove compatibility.
          </p>
          {activeBranches.length === 0 && (
            <p>
              Create or activate a branch in{' '}
              <Link href="/organization">Company setup</Link> before saving a
              draft.
            </p>
          )}
          {needsRefresh && (
            <p>Changes are locked until inventory is refreshed.</p>
          )}
          <form
            className="device-form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void mutate();
            }}
          >
            <fieldset
              disabled={busy || needsRefresh || activeBranches.length === 0}
            >
              <label>
                Device code
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  disabled={editing !== null}
                  required
                  maxLength={20}
                  pattern="[A-Z0-9]([A-Z0-9_]|-){0,19}"
                />
              </label>
              <label>
                Device name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={160}
                />
              </label>
              <label>
                Branch
                <select
                  value={branchId}
                  onChange={(event) => setBranchId(event.target.value)}
                  required
                >
                  <option value="">Choose active branch</option>
                  {activeBranches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Firmware label (optional)
                <input
                  value={firmware}
                  onChange={(event) => setFirmware(event.target.value)}
                  maxLength={64}
                />
              </label>
              <p>Model: ZKTeco K50 · timezone: Asia/Karachi</p>
              <div className="device-controls">
                <button className="primary-button" type="submit">
                  {editing ? 'Save metadata' : 'Register draft device'}
                </button>
                {editing && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={resetForm}
                  >
                    Cancel editing
                  </button>
                )}
              </div>
            </fieldset>
          </form>
        </section>
      )}
    </>
  );
}
