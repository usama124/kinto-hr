import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const directory = 'docs/implementation';
const files = [
  'PRODUCT-PLAN.md',
  ...readdirSync(directory)
    .filter((f) => f.endsWith('.md'))
    .map((f) => `${directory}/${f}`),
];
let count = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if ((text.match(/^```/gm)?.length ?? 0) % 2 !== 0)
    throw new Error(`Unbalanced code fence: ${file}`);
  for (const [, href] of text.matchAll(/\]\(([^)]+)\)/g)) {
    if (href.startsWith('https://') || href.startsWith('#')) continue;
    if (!existsSync(resolve(dirname(file), href.split('#')[0])))
      throw new Error(`Broken local link in ${file}: ${href}`);
    count++;
  }
}
console.log(
  `Validated ${files.length} planning documents and ${count} local links.`,
);
