import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const F321_TS_GLOB = 'test/memory/f321-*.test.ts';

// The F321 TypeScript suites had no runner until 2026-11-13. After the #5576 sender-identity
// contract (2026-10-15) six of them failed for a month without anyone seeing it, because neither
// `pnpm test` nor the gate's public lane collects `.test.ts`. Keep them on the canonical command.
test('canonical API test command executes every F321 TypeScript suite', () => {
  assert.match(packageJson.scripts.test, /&& pnpm run test:f321(?:\s|$)/);
  const script = packageJson.scripts['test:f321'] ?? '';
  assert.match(script, /--import tsx/);
  assert.ok(script.includes(`"${F321_TS_GLOB}"`), 'test:f321 hands the quoted F321 glob to node --test');
  const suites = readdirSync(new URL('./memory/', import.meta.url)).filter((name) => /^f321-.*\.test\.ts$/.test(name));
  assert.ok(suites.length > 0, 'the F321 glob still matches suites on disk');
});
