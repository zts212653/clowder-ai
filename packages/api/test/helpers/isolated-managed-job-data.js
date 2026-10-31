import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

// The durable ledger outlives a route fixture. Files that exercise its default
// owner need separate data roots even when the test runner shares one HOME.
export function isolateManagedJobData() {
  const previous = process.env.CAT_CAFE_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'managed-job-test-data-'));
  process.env.CAT_CAFE_DATA_DIR = root;
  after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
}
