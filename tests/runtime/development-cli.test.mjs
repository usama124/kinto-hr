import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const target of ['api', 'web']) {
  for (const mode of ['file', 'export', 'missing-file']) {
    test(`${target} launcher loads root env, preserves exports and avoids forwarding env flags: ${mode}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'kinto-development-cli-'));
      try {
        const scripts = join(root, 'scripts');
        const cli =
          target === 'api'
            ? join(root, 'node_modules/tsx/dist/cli.mjs')
            : join(root, 'apps/web/node_modules/next/dist/bin/next');
        const cwd = join(root, `apps/${target}`);
        await Promise.all([
          mkdir(scripts, { recursive: true }),
          mkdir(join(cli, '..'), { recursive: true }),
          mkdir(cwd, { recursive: true }),
        ]);
        await copyFile(
          new URL('../../scripts/dev-cli.mjs', import.meta.url),
          join(scripts, 'dev-cli.mjs'),
        );
        if (mode !== 'missing-file')
          await writeFile(
            join(root, '.env'),
            'DEV_FIXTURE_VALUE="from root file"\n',
          );
        await writeFile(
          cli,
          'console.log(JSON.stringify({value:process.env.DEV_FIXTURE_VALUE,args:process.argv.slice(2),nodeArgs:process.execArgv}));\n',
        );
        const env = { ...process.env };
        delete env.DEV_FIXTURE_VALUE;
        if (mode !== 'file') env.DEV_FIXTURE_VALUE = 'explicit override';
        const result = spawnSync(
          process.execPath,
          [join(scripts, 'dev-cli.mjs'), target, 'dev', '--port', '3100'],
          { cwd, env, encoding: 'utf8' },
        );
        assert.equal(result.status, 0);
        const output = JSON.parse(result.stdout.trim());
        assert.equal(
          output.value,
          mode === 'file' ? 'from root file' : 'explicit override',
        );
        assert.deepEqual(output.args, ['dev', '--port', '3100']);
        assert.deepEqual(output.nodeArgs, []);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
