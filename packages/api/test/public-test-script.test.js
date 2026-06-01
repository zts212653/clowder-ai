import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, '../package.json');

test('test:public excludes source-only governance pack assertions', () => {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const script = pkg.scripts?.['test:public'] ?? '';

  assert.ok(script.includes("grep -v 'governance-pack\\.test'"), script);
});
