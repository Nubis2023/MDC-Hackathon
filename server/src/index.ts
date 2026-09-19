/** Server entry point. */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './api';
import { DEFAULT_DB_PATH, openDb } from './db';

const port = Number(process.env.PORT ?? 4000);
const dbFile = process.env.DB_FILE ?? DEFAULT_DB_PATH;

mkdirSync(dirname(dbFile), { recursive: true });

const db = openDb({ filename: dbFile });
const app = createApp(db);

app.listen(port, () => {
  console.log(`seller-ledger api listening on http://localhost:${port}`);
  console.log(`database: ${dbFile}`);
});
