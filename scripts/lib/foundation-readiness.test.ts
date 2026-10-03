import {
  readFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  foundationManifestSchema,
  foundationReadinessReport,
  loadFoundationManifest,
  type FoundationManifest,
} from './foundation-readiness';

const source = async () =>
  JSON.parse(
    await readFile('docs/implementation/foundation-readiness.json', 'utf8'),
  ) as FoundationManifest;
it('checks the committed inventory but never equates historical evidence with current tests or approval', async () => {
  const manifest = await loadFoundationManifest(process.cwd());
  const report = foundationReadinessReport(manifest, 'a'.repeat(40), false);
  expect(report.status).toBe('review_required');
  expect(report.productionAccepted).toBe(false);
  expect(report.testsExecuted).toBe(false);
  expect(report.foundationBlockers).toHaveLength(9);
  expect(report.laterPhaseDependencies).toHaveLength(4);
  expect(foundationReadinessReport(manifest, 'b'.repeat(40), true).dirty).toBe(
    true,
  );
  expect(() => foundationReadinessReport(manifest, 'bad', false)).toThrow(
    'Invalid revision',
  );
});
it('refuses omitted, duplicate or falsely approved gates and unsafe paths', async () => {
  const manifest = await source();
  for (const mutate of [
    (value: FoundationManifest) => value.foundationGates.pop(),
    (value: FoundationManifest) => value.laterPhaseGates.pop(),
    (value: FoundationManifest) =>
      value.foundationGates.push(value.foundationGates[0]),
    (value: FoundationManifest) =>
      value.localEvidence.push(value.localEvidence[0]),
    (value: FoundationManifest) =>
      Object.assign(value.foundationGates[0], { status: 'approved' }),
    (value: FoundationManifest) =>
      Object.assign(value.localEvidence[0], {
        meaning: 'passed_at_current_revision',
      }),
    (value: FoundationManifest) =>
      Object.assign(value.localEvidence[0], { record: '../private.md' }),
    (value: FoundationManifest) =>
      Object.assign(value.localEvidence[0], {
        command: 'pnpm verify; cat .env',
      }),
    (value: FoundationManifest) =>
      Object.assign(value, { productionAccepted: true }),
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    expect(foundationManifestSchema.safeParse(changed).success).toBe(false);
  }
});
it('fails closed for missing, empty or escaping evidence without reading outside the repository', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'kinto-readiness-'));
  const outside = await mkdtemp(join(tmpdir(), 'kinto-readiness-outside-'));
  try {
    await mkdir(join(folder, 'docs/implementation'), { recursive: true });
    await writeFile(
      join(folder, 'package.json'),
      JSON.stringify({
        scripts: Object.fromEntries(
          (await source()).localEvidence.map((item) => [
            item.command.slice(5),
            'synthetic',
          ]),
        ),
      }),
    );
    await mkdir(join(folder, 'docs/evidence'), { recursive: true });
    const manifest = await source();
    for (const item of manifest.localEvidence)
      item.record = 'docs/evidence/test.md';
    for (const item of [
      ...manifest.foundationGates,
      ...manifest.laterPhaseGates,
    ])
      item.references = ['docs/evidence/test.md'];
    await writeFile(
      join(folder, 'docs/implementation/foundation-readiness.json'),
      JSON.stringify(manifest),
    );
    const packageContents = await readFile(
      join(folder, 'package.json'),
      'utf8',
    );
    await writeFile(
      join(folder, 'package.json'),
      JSON.stringify({ scripts: {} }),
    );
    await expect(loadFoundationManifest(folder)).rejects.toThrow(
      'Missing verification command',
    );
    await writeFile(join(folder, 'package.json'), packageContents);
    await expect(loadFoundationManifest(folder)).rejects.toThrow();
    await writeFile(join(folder, 'docs/evidence/test.md'), '');
    await expect(loadFoundationManifest(folder)).rejects.toThrow(
      'Evidence reference is empty',
    );
    await writeFile(
      join(folder, 'docs/evidence/test.md'),
      'Synthetic evidence',
    );
    expect((await loadFoundationManifest(folder)).localEvidence).toHaveLength(
      9,
    );
    await rm(join(folder, 'docs/evidence/test.md'));
    await writeFile(join(outside, 'private.md'), 'Private fixture');
    await symlink(
      join(outside, 'private.md'),
      join(folder, 'docs/evidence/test.md'),
    );
    await expect(loadFoundationManifest(folder)).rejects.toThrow(
      'Evidence must stay in repository',
    );
    await rm(join(folder, 'docs/evidence/test.md'));
    await writeFile(join(folder, 'private.txt'), 'Private fixture');
    await symlink(
      join(folder, 'private.txt'),
      join(folder, 'docs/evidence/test.md'),
    );
    await expect(loadFoundationManifest(folder)).rejects.toThrow(
      'Evidence must be Markdown in docs',
    );
    await rm(join(folder, 'docs/implementation/foundation-readiness.json'));
    await writeFile(
      join(outside, 'foundation-readiness.json'),
      JSON.stringify(manifest),
    );
    await symlink(
      join(outside, 'foundation-readiness.json'),
      join(folder, 'docs/implementation/foundation-readiness.json'),
    );
    await expect(loadFoundationManifest(folder)).rejects.toThrow(
      'Manifest must stay in repository',
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
it('separates integrity success from review failure and rejects bypass arguments with bounded JSON diagnostics', async () => {
  const run = async (args: string[]) => {
    let code = 0;
    let output: { stdout: string; stderr: string };
    try {
      output = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'scripts/check-foundation-readiness.ts', ...args],
        { timeout: 10000 },
      );
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      code = failure.code;
      output = failure;
    }
    expect(output.stderr).toBe('');
    return { code, report: JSON.parse(output.stdout.trim()) };
  };
  expect(await run(['--verify-manifest'])).toEqual({
    code: 0,
    report: {
      status: 'manifest_valid',
      productionAccepted: false,
      testsExecuted: false,
    },
  });
  const blocked = await run([]);
  expect(blocked.code).toBe(1);
  expect(blocked.report.productionAccepted).toBe(false);
  expect(blocked.report.revision).toMatch(/^[a-f0-9]{40}$/);
  const invalid = await run(['--approve']);
  expect(invalid).toEqual({
    code: 2,
    report: {
      status: 'inventory_unavailable',
      productionAccepted: false,
      testsExecuted: false,
    },
  });
});
