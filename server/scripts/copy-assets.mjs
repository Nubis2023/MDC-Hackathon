/**
 * Copy non-TypeScript assets into dist/.
 *
 * tsc only emits JavaScript, so schema.sql would be missing from dist/ and
 * `npm start` would fail at startup looking for it. This runs as part of the
 * build so the compiled output is self-contained.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');

const assets = [['src/db/schema.sql', 'dist/db/schema.sql']];

for (const [from, to] of assets) {
  const src = join(serverRoot, from);
  const dest = join(serverRoot, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`copied ${from} -> ${to}`);
}
