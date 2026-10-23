import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { inspectDshRouteReadiness } from '../dist/routes/dsh-setup-readiness.js';

const source = stringify([
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        company: { apiKeyEnv: 'COMPANY_KEY', models: [{ id: 'private' }] },
        missing: { apiKeyEnv: 'MISSING_KEY', models: [{ id: 'unavailable' }] },
        'deepseek-official': { models: [{ id: 'official' }] },
      },
    },
  },
]);
test('reads saved DSH credential references without exposing or rewriting them', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ready-'));
  const path = join(home, '.credentials.yaml');
  const bytes = 'version: 1\nrefs:\n  COMPANY_KEY: private-fixture-value\n';
  writeFileSync(path, bytes);
  const view = inspectDshRouteReadiness(source, home, home, {});
  assert.deepEqual(
    view.providers.map((route) => [route.id, route.credentialStatus]),
    [
      ['company', 'configured'],
      ['missing', 'missing'],
      ['deepseek-official', 'missing'],
    ],
  );
  assert.ok(!JSON.stringify(view).includes('private-fixture-value'));
  assert.equal(readFileSync(path, 'utf8'), bytes);
});
test('retains legacy references and inherited/HOME dotenv credential support', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ready-'));
  const cwd = join(home, 'bootstrap');
  mkdirSync(cwd);
  writeFileSync(join(home, '.credentials.yaml'), 'COMPANY_KEY: local-fixture\n');
  writeFileSync(join(home, '.env'), 'DEEPSEEK_API_KEY=home-fixture\n');
  const view = inspectDshRouteReadiness(source, home, cwd, { MISSING_KEY: 'env-fixture' });
  assert.ok(view.providers.every((route) => route.credentialStatus === 'configured'));
  assert.ok(!JSON.stringify(view).includes('fixture'));
});
test('a stored native route API-key record is usable without inventing an env reference', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-ready-'));
  writeFileSync(
    join(home, '.credentials.yaml'),
    'version: 1\nrecords:\n  llm-pi-ai/deepseek-official:\n    kind: api-key\n    key: fixture-only\n',
  );
  const view = inspectDshRouteReadiness(source, home, home, {});
  assert.equal(view.providers.find((route) => route.id === 'deepseek-official')?.credentialStatus, 'configured');
});
