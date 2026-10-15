import {
  leaveLifecycleInputSchema,
  leaveLifecyclePreviewSchema,
  type LeaveLifecyclePreview,
  type LeaveLifecycleReviewCode,
} from '@kinto/contracts';

// Pure transition plan only: no authorization, receipt, ledger write or locking.
// A future transaction must re-resolve and lock every supplied snapshot.
export function previewLeaveDecision(input: unknown): LeaveLifecyclePreview {
  const { request, command, context } = leaveLifecycleInputSchema.parse(input);
  if (
    command.tenantId !== request.tenantId ||
    context.tenantId !== request.tenantId ||
    command.employeeId !== request.employeeId ||
    context.employeeId !== request.employeeId ||
    command.requestId !== request.requestId
  )
    throw new Error('LEAVE_SCOPE_MISMATCH');
  const common = {
    tenantId: request.tenantId,
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    requestId: request.requestId,
    actorId: command.actorId,
    leaveReservationAvailable: false as const,
    payrollEffectsAvailable: false as const,
  };
  const review = (code: LeaveLifecycleReviewCode) =>
    leaveLifecyclePreviewSchema.parse({
      ...common,
      status: 'needs_review',
      code,
    });
  // Check supplied eligibility before exposing state, including stale versions.
  const ownRequest =
    command.actorId === request.employeeIdentityId ||
    command.actorId === request.submittedBy;
  const hr = context.eligibleHrIds.includes(command.actorId);
  const approver =
    !ownRequest &&
    (context.eligibleManagerId !== null
      ? command.actorId === context.eligibleManagerId
      : hr);
  if (command.action === 'cancel' ? !ownRequest && !hr : !approver)
    return review('LEAVE_DECISION_FORBIDDEN');
  if (command.expectedVersion !== request.version)
    return review('LEAVE_REQUEST_STALE');
  if (command.expectedRoutingVersion !== context.routingVersion)
    return review('LEAVE_ROUTING_STALE');
  if (request.status === 'approved' && command.action === 'cancel')
    return review('LEAVE_APPROVED_REVERSAL_REQUIRED');
  if (request.status !== 'pending') return review('LEAVE_INVALID_TRANSITION');
  if (request.version === 2147483647) return review('LEAVE_VERSION_EXHAUSTED');
  const periods = new Map(context.periods.map((p) => [p.date, p.state]));
  if (request.dates.some((d) => periods.get(d.date) === 'locked'))
    return review('LEAVE_PERIOD_LOCKED');
  if (
    context.periods.length !== request.dates.length ||
    request.dates.some((d) => periods.get(d.date) !== 'open')
  )
    return review('LEAVE_PERIOD_UNRESOLVED');

  const annual = new Map<string, number>();
  const monthly = new Map<string, number>();
  const suffix = `-${String(request.leaveYearStart.month).padStart(2, '0')}-${String(request.leaveYearStart.day).padStart(2, '0')}`;
  for (const d of request.dates) {
    if (!d.chargeable) continue;
    const year = Number(d.date.slice(0, 4));
    const beginning =
      d.date < `${d.date.slice(0, 4)}${suffix}` ? year - 1 : year;
    if (beginning < 1 || beginning >= 9999)
      return review('LEAVE_ALLOCATION_UNRESOLVED');
    const from = `${String(beginning).padStart(4, '0')}${suffix}`;
    const month = d.date.slice(0, 7);
    const units = d.part === 'full_day' ? 2 : 1;
    annual.set(from, (annual.get(from) ?? 0) + units);
    monthly.set(month, (monthly.get(month) ?? 0) + units);
  }
  const approved = command.action === 'approve';
  const deltas = (bucket: 'annual' | 'monthly', values: Map<string, number>) =>
    [...values]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, units]) => ({
        bucket,
        period,
        reservedHalfUnits: -units,
        usedHalfUnits: approved ? units : 0,
      }));
  return leaveLifecyclePreviewSchema.parse({
    ...common,
    status: 'transition_candidate',
    expectedVersion: request.version,
    nextVersion: request.version + 1,
    expectedRoutingVersion: context.routingVersion,
    nextStatus: approved
      ? 'approved'
      : command.action === 'reject'
        ? 'rejected'
        : 'cancelled',
    policyId: request.policyId,
    policyVersion: request.policyVersion,
    pay: request.pay,
    occupancy: approved ? 'retain' : 'release',
    deltas: [...deltas('annual', annual), ...deltas('monthly', monthly)],
  });
}
