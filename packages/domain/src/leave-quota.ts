import {
  leaveQuotaPreviewInputSchema,
  leaveQuotaPreviewSchema,
  type LeaveQuotaPreview,
  type LeaveQuotaReviewCode,
} from '@kinto/contracts';
const dayMilliseconds = 86400000;
const pad = (n: number) => String(n).padStart(2, '0');
function leaveYear(date: string, start: { month: number; day: number }) {
  const year = Number(date.slice(0, 4)),
    suffix = `-${pad(start.month)}-${pad(start.day)}`;
  const current = `${String(year).padStart(4, '0')}${suffix}`;
  const beginning = date < current ? year - 1 : year;
  if (beginning < 0 || beginning >= 9999) return null;
  return {
    from: `${String(beginning).padStart(4, '0')}${suffix}`,
    until: `${String(beginning + 1).padStart(4, '0')}${suffix}`,
  };
}
// Pure all-or-nothing quota plan only. Commit requires independent authority,
// effective policy/usage resolution, deterministic bucket locks and receipt replay.
export function previewLeaveQuota(input: unknown): LeaveQuotaPreview {
  const { policy, request, usage } = leaveQuotaPreviewInputSchema.parse(input);
  if (
    policy.tenantId !== request.tenantId ||
    usage.tenantId !== request.tenantId ||
    policy.leaveTypeId !== request.leaveTypeId ||
    usage.leaveTypeId !== request.leaveTypeId ||
    usage.employeeId !== request.employeeId
  )
    throw new Error('LEAVE_SCOPE_MISMATCH');
  const common = {
    tenantId: request.tenantId,
    employeeId: request.employeeId,
    leaveTypeId: request.leaveTypeId,
    requestId: request.requestId,
    policyId: policy.id,
    policyVersion: policy.version,
    leaveReservationAvailable: false as const,
    payrollEffectsAvailable: false as const,
  };
  const review = (code: LeaveQuotaReviewCode) =>
    leaveQuotaPreviewSchema.parse({ ...common, status: 'needs_review', code });
  if (request.expectedUsageVersion !== usage.version)
    return review('LEAVE_USAGE_STALE');
  if (
    policy.settings.leaveYearStart.month !== usage.leaveYearStart.month ||
    policy.settings.leaveYearStart.day !== usage.leaveYearStart.day
  )
    return review('LEAVE_YEAR_CHANGE_REQUIRES_RECONCILIATION');
  const dates = [...request.dates].sort((a, b) => a.date.localeCompare(b.date));
  if (
    new Set(dates.map((d) => d.date)).size !== dates.length ||
    Date.parse(dates.at(-1)!.date + 'T00:00:00Z') -
      Date.parse(dates[0].date + 'T00:00:00Z') >
      365 * dayMilliseconds
  )
    return review('LEAVE_INVALID_REQUEST');
  if (
    dates.some(
      (d) =>
        d.date < policy.effectiveFrom ||
        (policy.effectiveUntil !== null && d.date >= policy.effectiveUntil),
    )
  )
    return review('LEAVE_POLICY_CHANGE_REQUIRES_SPLIT');
  if (dates.some((d) => d.periodState === 'locked'))
    return review('LEAVE_PERIOD_LOCKED');
  if (dates.some((d) => d.calendar === 'unknown'))
    return review('LEAVE_CALENDAR_UNRESOLVED');
  if (dates.some((d) => d.calendar === 'not_employed'))
    return review('LEAVE_NOT_EMPLOYED');
  const chargeable = dates.filter(
    (d) =>
      policy.settings.nonWorkingDays === 'include' ||
      d.calendar === 'working_day',
  );
  if (!chargeable.length) return review('LEAVE_NO_CHARGEABLE_DATES');
  if (
    chargeable.some((d) =>
      usage.occupied.some(
        (o) =>
          o.date === d.date &&
          (o.part === 'full_day' || d.part === 'full_day' || o.part === d.part),
      ),
    )
  )
    return review('LEAVE_OVERLAP');
  const annualUsage = new Map(usage.annual.map((b) => [b.from, b])),
    monthlyUsage = new Map(usage.monthly.map((b) => [b.month, b]));
  if (
    annualUsage.size !== usage.annual.length ||
    monthlyUsage.size !== usage.monthly.length ||
    usage.annual.some((b) => b.reservedDays + b.usedDays > 366) ||
    usage.monthly.some((b) => b.reservedDays + b.usedDays > 31) ||
    usage.annual.some((b) => {
      const expected = leaveYear(b.from, usage.leaveYearStart);
      return (
        !expected || expected.from !== b.from || expected.until !== b.until
      );
    })
  )
    return review('LEAVE_USAGE_UNRESOLVED');
  const annualRequested = new Map<
      string,
      { from: string; until: string; halfUnits: number }
    >(),
    monthlyRequested = new Map<string, number>();
  for (const date of chargeable) {
    const period = leaveYear(date.date, policy.settings.leaveYearStart);
    if (!period) return review('LEAVE_USAGE_UNRESOLVED');
    const units = date.part === 'full_day' ? 2 : 1;
    const prior = annualRequested.get(period.from);
    annualRequested.set(period.from, {
      ...period,
      halfUnits: (prior?.halfUnits ?? 0) + units,
    });
    const month = date.date.slice(0, 7);
    monthlyRequested.set(month, (monthlyRequested.get(month) ?? 0) + units);
  }
  const annual = [] as {
    from: string;
    until: string;
    quotaDays: number;
    reservedDays: number;
    usedDays: number;
    requestedDays: number;
    availableBeforeDays: number;
    availableAfterDays: number;
  }[];
  const monthly = [] as {
    month: string;
    quotaDays: number;
    reservedDays: number;
    usedDays: number;
    requestedDays: number;
    availableBeforeDays: number;
    availableAfterDays: number;
  }[];
  const exceeded = (
    kind: 'annual' | 'monthly',
    period: string,
    bucket: { reservedDays: number; usedDays: number },
    requestedDays: number,
    quotaDays: number,
  ) =>
    leaveQuotaPreviewSchema.parse({
      ...common,
      status: 'quota_exceeded',
      code:
        kind === 'annual'
          ? 'LEAVE_ANNUAL_QUOTA_EXCEEDED'
          : 'LEAVE_MONTHLY_QUOTA_EXCEEDED',
      period,
      quotaDays,
      ...bucket,
      requestedDays,
      availableDays: Math.max(
        0,
        quotaDays - bucket.reservedDays - bucket.usedDays,
      ),
      overLimitDays: Math.max(
        0,
        bucket.reservedDays + bucket.usedDays - quotaDays,
      ),
    });
  for (const [from, demand] of [...annualRequested].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const stored = annualUsage.get(from);
    if (!stored || stored.until !== demand.until)
      return review('LEAVE_USAGE_UNRESOLVED');
    const requestedDays = demand.halfUnits / 2,
      quotaDays = policy.settings.annualQuotaDays;
    const availableBeforeDays = Math.max(
      0,
      quotaDays - stored.reservedDays - stored.usedDays,
    );
    if (requestedDays > availableBeforeDays)
      return exceeded(
        'annual',
        from,
        { reservedDays: stored.reservedDays, usedDays: stored.usedDays },
        requestedDays,
        quotaDays,
      );
    annual.push({
      from,
      until: demand.until,
      quotaDays,
      reservedDays: stored.reservedDays,
      usedDays: stored.usedDays,
      requestedDays,
      availableBeforeDays,
      availableAfterDays: availableBeforeDays - requestedDays,
    });
  }
  for (const [month, halfUnits] of [...monthlyRequested].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const stored = monthlyUsage.get(month);
    if (!stored) return review('LEAVE_USAGE_UNRESOLVED');
    const requestedDays = halfUnits / 2,
      quotaDays = policy.settings.monthlyQuotaDays;
    const availableBeforeDays = Math.max(
      0,
      quotaDays - stored.reservedDays - stored.usedDays,
    );
    if (requestedDays > availableBeforeDays)
      return exceeded(
        'monthly',
        month,
        { reservedDays: stored.reservedDays, usedDays: stored.usedDays },
        requestedDays,
        quotaDays,
      );
    monthly.push({
      month,
      quotaDays,
      reservedDays: stored.reservedDays,
      usedDays: stored.usedDays,
      requestedDays,
      availableBeforeDays,
      availableAfterDays: availableBeforeDays - requestedDays,
    });
  }
  return leaveQuotaPreviewSchema.parse({
    ...common,
    status: 'reservation_candidate',
    expectedUsageVersion: usage.version,
    pay: policy.settings.pay,
    annual,
    monthly,
    chargeableDates: chargeable.map((d) => ({
      date: d.date,
      part: d.part,
      days: d.part === 'full_day' ? 1 : 0.5,
    })),
    excludedDates: dates
      .filter((d) => !chargeable.includes(d))
      .map((d) => d.date),
    totalRequestedDays: chargeable.reduce(
      (sum, d) => sum + (d.part === 'full_day' ? 1 : 0.5),
      0,
    ),
  });
}
