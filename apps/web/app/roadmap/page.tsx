import Link from 'next/link';
const phases = [
  [
    '0',
    'Validation',
    'In progress',
    'K50 firmware, independent payroll fixtures and deployment approvals remain external gates.',
  ],
  [
    '1',
    'Platform & people',
    'Foundation in progress',
    'Workspace, API and tenant-safe persistence first. Authentication and employee screens follow.',
  ],
  [
    '2',
    'Attendance & leave',
    'Planned',
    'Device synchronization, shifts, leave balances and locked attendance inputs.',
  ],
  [
    '3',
    'Pakistan payroll',
    'Planned',
    'Reviewed rules, immutable payroll runs, payslips and export.',
  ],
  [
    '4',
    'Commercial release',
    'Planned',
    'Subscriptions, recovery exercises and two reconciled live payroll cycles.',
  ],
  [
    '5',
    'Expenses & assets',
    'Planned',
    'Approved reimbursements, asset custody and return workflows.',
  ],
];
export default function Roadmap() {
  return (
    <>
      <p className="eyebrow">DELIVERY ROADMAP</p>
      <h1>Built in deliberate steps.</h1>
      <p className="subtitle">
        Each phase has its own specification, tests and release gates.
      </p>
      <ol className="phase-list">
        {phases.map(([number, title, state, description]) => (
          <li key={number}>
            <span className="phase-number">{number}</span>
            <div>
              <div className="phase-title">
                <h2>{title}</h2>
                <span>{state}</span>
              </div>
              <p>{description}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="notice">
        <strong>Verified progress, not a completion estimate.</strong>
        <p>
          The foundation does not establish production readiness. Hardware,
          payroll and customer approvals cannot be replaced by passing software
          tests.
        </p>
      </div>
      <Link className="text-link" href="/">
        ← Back to overview
      </Link>
    </>
  );
}
