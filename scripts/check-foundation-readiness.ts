import { execFileSync } from 'node:child_process';
import {
  loadFoundationManifest,
  foundationReadinessReport,
} from './lib/foundation-readiness';

async function main() {
  try {
    const args = process.argv.slice(2);
    if (
      args.length > 1 ||
      (args.length === 1 && args[0] !== '--verify-manifest')
    )
      throw new Error('Invalid arguments');
    const manifest = await loadFoundationManifest(process.cwd());
    if (args[0] === '--verify-manifest') {
      console.log(
        JSON.stringify({
          status: 'manifest_valid',
          productionAccepted: false,
          testsExecuted: false,
        }),
      );
      return;
    }
    const git = (args: string[]) =>
      execFileSync('git', args, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    console.log(
      JSON.stringify(
        foundationReadinessReport(
          manifest,
          git(['rev-parse', 'HEAD']),
          git(['status', '--porcelain']).length > 0,
        ),
      ),
    );
    // Review inventory is not an approval engine. No manifest can grant deployment access.
    process.exitCode = 1;
  } catch {
    console.log(
      JSON.stringify({
        status: 'inventory_unavailable',
        productionAccepted: false,
        testsExecuted: false,
      }),
    );
    process.exitCode = 2;
  }
}
void main();
