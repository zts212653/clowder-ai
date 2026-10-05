import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Node loads this before test modules and in each test worker. Never let a
// mocked successful fetch acknowledge callbacks owned by the launching user.
const outbox = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-test-outbox-'));
process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR = outbox;
process.env.CAT_CAFE_CALLBACK_OUTBOX_ENABLED = 'true';
process.once('exit', () => rmSync(outbox, { recursive: true, force: true }));
