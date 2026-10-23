import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { hasPersistedDshSetup } from '../dist/routes/dsh-persisted-setup.js';

test('only a complete Host-owned prepared route avoids asking an existing DSH member again', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-owned-'));
  const before = { DSH_HOME: process.env.DSH_HOME, CAT_CAFE_CONFIG_ROOT: process.env.CAT_CAFE_CONFIG_ROOT };
  process.env.DSH_HOME = root;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const directory = join(root, '.cat-cafe', 'dsh-acp');
  mkdirSync(directory, { recursive: true });
  const patch = join(directory, `${randomUUID()}.yml`);
  writeFileSync(join(root, '.credentials.yaml'), 'version: 1\nrefs:\n  DSH_OWNED_FIXTURE_KEY: local-only\n');
  writeFileSync(
    patch,
    stringify([
      {
        id: 'llm-pi-ai',
        config: { providers: { company: { apiKeyEnv: 'DSH_OWNED_FIXTURE_KEY', models: [{ id: 'private' }] } } },
      },
      { id: 'acp', config: { provider: 'company', model: 'private' } },
    ]),
  );
  assert.equal(hasPersistedDshSetup(['--profile', 'acp'], root), false);
  assert.equal(hasPersistedDshSetup(['--profile', 'acp', '--patch', patch], root), true);
  const arbitrary = join(root, 'custom.yml');
  writeFileSync(arbitrary, '[]');
  assert.equal(hasPersistedDshSetup(['--profile', 'acp', '--patch', arbitrary], root), false);
  assert.equal(hasPersistedDshSetup(['--profile', 'acp', '--patch', patch, '--patch', arbitrary], root), false);
  writeFileSync(join(root, '.credentials.yaml'), 'version: 1\nrefs: {}\n');
  assert.equal(hasPersistedDshSetup(['--profile', 'acp', '--patch', patch], root), false);
});
