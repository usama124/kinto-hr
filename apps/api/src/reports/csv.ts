import type {
  WorkforceHeadcountReport,
  WorkforceReportExportDownload,
} from '@kinto/contracts';

const dangerousSpreadsheetPrefix = /^[\t\r ]*[=+\-@]/;

export function safeCsvCell(value: string | number): string {
  let text = String(value);
  if (dangerousSpreadsheetPrefix.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function workforceHeadcountCsv(
  report: WorkforceHeadcountReport,
): Buffer {
  const header = [
    'record_type',
    'as_of',
    'period_start',
    'period_end',
    'metric',
    'department_code',
    'department_name',
    'count',
  ];
  const summary = [
    [
      'summary',
      report.asOf,
      report.periodStart,
      report.periodEnd,
      'headcount',
      '',
      '',
      report.headcount,
    ],
    [
      'summary',
      report.asOf,
      report.periodStart,
      report.periodEnd,
      'joiners',
      '',
      '',
      report.joiners,
    ],
    [
      'summary',
      report.asOf,
      report.periodStart,
      report.periodEnd,
      'leavers',
      '',
      '',
      report.leavers,
    ],
    [
      'summary',
      report.asOf,
      report.periodStart,
      report.periodEnd,
      'unassigned_headcount',
      '',
      '',
      report.unassignedHeadcount,
    ],
  ];
  const departments = report.departments.map((department) => [
    'department',
    report.asOf,
    report.periodStart,
    report.periodEnd,
    'department_headcount',
    department.departmentCode,
    department.departmentName,
    department.headcount,
  ]);
  const rows: (string | number)[][] = [header, ...summary, ...departments];
  return Buffer.from(
    `\uFEFF${rows.map((row) => row.map(safeCsvCell).join(',')).join('\r\n')}\r\n`,
    'utf8',
  );
}

export function workforceExportFileName(
  download: WorkforceReportExportDownload,
): string {
  return `workforce-headcount-${download.report.asOf}-${download.export.id}.csv`;
}
