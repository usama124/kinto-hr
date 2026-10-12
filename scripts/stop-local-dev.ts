import { readFile, readlink, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
process.chdir(root);
async function main() {
  const file = '.local/auth/application.pid';
  let saved: string;
  try {
    saved = (await readFile(file, 'utf8')).trim();
  } catch {
    console.log(
      'No managed local application PID. Use Ctrl+C in an older dev terminal.',
    );
    return;
  }
  if (!/^[1-9][0-9]*$/.test(saved)) throw new Error('Invalid local PID file');
  const pid = Number(saved);
  let args: string[];
  try {
    args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  } catch {
    await unlink(file);
    console.log('The recorded local application has already stopped.');
    return;
  }
  if (
    process.platform !== 'linux' ||
    (await readlink(`/proc/${pid}/cwd`)) !== root ||
    !args.some(
      (arg) =>
        arg === 'scripts/local-dev.ts' ||
        arg === `${root}/scripts/local-dev.ts`,
    )
  )
    throw new Error('Refusing to stop an unrelated process');
  process.kill(pid, 'SIGTERM');
  console.log(
    'Requested graceful stop of this managed Kinto application. Keycloak, mail and databases remain running.',
  );
}
main().catch(() => {
  console.error(
    'Could not safely identify/stop the local application. Use its terminal Ctrl+C.',
  );
  process.exitCode = 1;
});
