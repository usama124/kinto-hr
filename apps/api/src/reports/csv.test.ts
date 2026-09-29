import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  safeCsvCell,
  workforceExportFileName,
  workforceHeadcountCsv,
} from './csv';

it('quotes RFC CSV values and neutralizes spreadsheet formulas after whitespace', () => {
  expect(safeCsvCell('Engineering, North')).toBe('"Engineering, North"');
  expect(safeCsvCell('A "quoted" team')).toBe('"A ""quoted"" team"');
  expect(safeCsvCell('=2+2')).toBe("'=2+2");
  expect(safeCsvCell('  @SUM(A1:A2)')).toBe("'  @SUM(A1:A2)");
  expect(safeCsvCell('-1')).toBe("'-1");
  expect(safeCsvCell('Operations')).toBe('Operations');
});

it('creates deterministic UTF-8 BOM and CRLF workforce CSV without IDs', () => {
  const report = {
    asOf: '2026-09-25',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    headcount: 3,
    joiners: 1,
    leavers: 0,
    departments: [
      {
        departmentId: randomUUID(),
        departmentCode: '=DANGER',
        departmentName: 'Research, "Labs"',
        headcount: 3,
      },
    ],
    unassignedHeadcount: 0,
  };
  const first = workforceHeadcountCsv(report);
  const second = workforceHeadcountCsv(report);
  expect(first.equals(second)).toBe(true);
  expect([...first.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = first.toString('utf8');
  expect(text).toContain(
    `department_headcount,'=DANGER,"Research, ""Labs""",3\r\n`,
  );
  expect(text).not.toContain(report.departments[0].departmentId);
  expect(text.split('\r\n').filter(Boolean)).toHaveLength(6);
});

it('uses only server-owned values in an attachment-safe filename', () => {
  const exportId = randomUUID();
  expect(
    workforceExportFileName({
      export: {
        id: exportId,
        kind: 'workforce_headcount_csv',
        status: 'ready',
        parameters: {
          asOf: '2026-09-25',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
        },
        createdAt: '2026-09-25T10:00:00.000Z',
        expiresAt: '2026-09-26T10:00:00.000Z',
      },
      report: {
        asOf: '2026-09-25',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        headcount: 0,
        joiners: 0,
        leavers: 0,
        departments: [],
        unassignedHeadcount: 0,
      },
    }),
  ).toBe(`workforce-headcount-2026-09-25-${exportId}.csv`);
});
