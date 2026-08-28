import { existsSync } from 'node:fs';
import { workerConfig } from './config';
import { startWorker } from './runtime';

// pnpm runs workspace scripts from apps/worker; built runtime also supports root cwd.
if (existsSync('.env')) process.loadEnvFile('.env');
else if (existsSync('../../.env')) process.loadEnvFile('../../.env');

async function main() {
  const startupDeadline = setTimeout(() => {
    console.error('Worker startup timed out');
    process.exit(1);
  }, 15000);
  const starting = startWorker(workerConfig(process.env));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    void starting
      .then((runtime) => runtime.close())
      .then(() => clearTimeout(deadline))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await starting;
  clearTimeout(startupDeadline);
}
void main().catch(() => {
  console.error(
    'Worker startup failed; check configuration and service access.',
  );
  process.exit(1);
});
