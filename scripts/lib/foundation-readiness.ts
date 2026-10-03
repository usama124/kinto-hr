import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

// Mandatory review areas cannot disappear merely by removing a manifest row.
export const foundationGateIds = [
  'pilot_scope',
  'hosting',
  'privacy_security',
  'provider_operations',
  'storage_scanning',
  'recovery',
  'retention_support',
  'staging_acceptance',
  'release_ci',
] as const;
export const laterGateIds = [
  'k50_hardware',
  'connector_distribution',
  'payroll_review',
  'commercial_billing',
] as const;
export const localEvidenceIds = [
  'verification',
  'isolation',
  'integration',
  'migrations',
  'recovery',
  'build',
  'worker',
  'browser',
  'provider',
] as const;
const pathSchema = z.string().regex(/^docs\/[a-zA-Z0-9/_-]+\.md$/);
const gateSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  owner: z.string().min(1).max(120),
  status: z.literal('review_required'),
  requiredEvidence: z.string().min(1).max(500),
  references: pathSchema.array().min(1).max(5),
});
export const foundationManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scope: z.literal('foundation_review_inventory'),
    localEvidence: z
      .strictObject({
        id: z.string().regex(/^[a-z][a-z0-9_]*$/),
        command: z.string().regex(/^pnpm [a-zA-Z0-9:_-]+$/),
        record: pathSchema,
        meaning: z.literal('historical_local_evidence_not_current_test_result'),
      })
      .array()
      .min(1)
      .max(30),
    foundationGates: gateSchema.array(),
    laterPhaseGates: gateSchema.array(),
  })
  .superRefine((manifest, context) => {
    const exact = (
      actual: string[],
      expected: readonly string[],
      path: string,
    ) => {
      if (
        new Set(actual).size !== actual.length ||
        [...actual].sort().join('|') !== [...expected].sort().join('|')
      )
        context.addIssue({
          code: 'custom',
          path: [path],
          message: 'Required review inventory changed',
        });
    };
    exact(
      manifest.foundationGates.map((gate) => gate.id),
      foundationGateIds,
      'foundationGates',
    );
    exact(
      manifest.laterPhaseGates.map((gate) => gate.id),
      laterGateIds,
      'laterPhaseGates',
    );
    exact(
      manifest.localEvidence.map((evidence) => evidence.id),
      localEvidenceIds,
      'localEvidence',
    );
  });
export type FoundationManifest = z.infer<typeof foundationManifestSchema>;

export async function loadFoundationManifest(
  root: string,
): Promise<FoundationManifest> {
  const base = await realpath(root);
  const manifestPath = await realpath(
    resolve(base, 'docs/implementation/foundation-readiness.json'),
  );
  const manifestRelative = relative(base, manifestPath);
  if (
    isAbsolute(manifestRelative) ||
    manifestRelative === '..' ||
    manifestRelative.startsWith(`..${sep}`)
  )
    throw new Error('Manifest must stay in repository');
  const manifest = foundationManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );
  const packagePath = await realpath(resolve(base, 'package.json'));
  const packageRelative = relative(base, packagePath);
  if (
    isAbsolute(packageRelative) ||
    packageRelative === '..' ||
    packageRelative.startsWith(`..${sep}`)
  )
    throw new Error('Package manifest must stay in repository');
  const packageJson = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(packagePath, 'utf8')));
  for (const item of manifest.localEvidence) {
    if (!Object.hasOwn(packageJson.scripts, item.command.slice(5)))
      throw new Error('Missing verification command');
  }
  const references = new Set([
    ...manifest.localEvidence.map((evidence) => evidence.record),
    ...[...manifest.foundationGates, ...manifest.laterPhaseGates].flatMap(
      (gate) => gate.references,
    ),
  ]);
  for (const reference of references) {
    const target = await realpath(resolve(base, reference));
    const path = relative(base, target);
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
      throw new Error('Evidence must stay in repository');
    if (!path.startsWith(`docs${sep}`) || !target.endsWith('.md'))
      throw new Error('Evidence must be Markdown in docs');
    const contents = await readFile(target, 'utf8');
    if (!contents.trim()) throw new Error('Evidence reference is empty');
  }
  return manifest;
}
export function foundationReadinessReport(
  manifest: FoundationManifest,
  revision: string,
  dirty: boolean,
) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid revision');
  return {
    schemaVersion: 1,
    scope: manifest.scope,
    revision,
    dirty,
    status: 'review_required' as const,
    productionAccepted: false,
    testsExecuted: false,
    localEvidence: manifest.localEvidence,
    foundationBlockers: manifest.foundationGates,
    laterPhaseDependencies: manifest.laterPhaseGates,
  };
}
