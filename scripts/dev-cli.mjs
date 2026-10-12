import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load before either CLI evaluates application configuration. Using the built-in
// loader here avoids Next forwarding --env-file flags into unsupported NODE_OPTIONS.
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const targets = {
  api: new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url),
  web: new URL('../apps/web/node_modules/next/dist/bin/next', import.meta.url),
};
const target = targets[process.argv[2]];
if (!target) throw new Error('Development CLI requires api or web target');
process.argv = [
  process.argv[0],
  fileURLToPath(target),
  ...process.argv.slice(3),
];
await import(target.href);
