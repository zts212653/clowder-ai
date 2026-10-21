import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { validateB1aEnv } from '../dist/remote-spike.js';

const ENV_KEYS = [
  'CAT_CAFE_REMOTE_TOKEN',
  'CAT_CAFE_DESKTOP_MODE',
  'CAT_CAFE_READONLY',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_AGENT_KEY_SECRET',
  'CAT_CAFE_AGENT_KEY_FILES',
  'CAT_CAFE_AGENT_KEY_BOUND_CAT_ID',
];
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots = [];

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configureDedicatedSpike(catId = 'gpt-pro') {
  const root = mkdtempSync(join(tmpdir(), 'f247-bound-spike-'));
  tempRoots.push(root);
  const keyFile = join(root, `${catId.replace(/[^A-Za-z0-9._-]/g, '_')}.secret`);
  writeFileSync(keyFile, 'test-agent-key\n', { mode: 0o600 });
  Object.assign(process.env, {
    CAT_CAFE_REMOTE_TOKEN: 'test-remote-token',
    CAT_CAFE_DESKTOP_MODE: 'cloud-pro-phase0',
    CAT_CAFE_READONLY: 'true',
    CAT_CAFE_CAT_ID: catId,
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
    CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ [catId]: keyFile }),
    CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: catId,
  });
  delete process.env.CAT_CAFE_INVOCATION_ID;
  delete process.env.CAT_CAFE_CALLBACK_TOKEN;
  delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
  return keyFile;
}

test('dedicated Remote MCP validates its service-bound gpt-pro principal', () => {
  configureDedicatedSpike();
  assert.doesNotThrow(() => validateB1aEnv());
});

test('dedicated Remote MCP fails closed when its service-bound principal is absent', () => {
  configureDedicatedSpike();
  delete process.env.CAT_CAFE_AGENT_KEY_BOUND_CAT_ID;
  assert.throws(() => validateB1aEnv(), /CAT_CAFE_AGENT_KEY_BOUND_CAT_ID must equal CAT_CAFE_CAT_ID \("gpt-pro"\)/);
});

// F202 h3c-2 — the gateway serves the configured cloud cat, whatever its id; the launcher names it.
// The mode, read-only and credential-binding gates hold exactly as before (astra …000188, negative case 1).

test('the gateway binds the configured cloud cat under any id', () => {
  configureDedicatedSpike('cloud-alt');
  assert.doesNotThrow(() => validateB1aEnv());
});

test('the bound identity, the cat id and the single key-map entry must all name the same cat', () => {
  configureDedicatedSpike('cloud-alt');
  process.env.CAT_CAFE_AGENT_KEY_BOUND_CAT_ID = 'gpt-pro';
  assert.throws(() => validateB1aEnv(), /CAT_CAFE_AGENT_KEY_BOUND_CAT_ID must equal CAT_CAFE_CAT_ID \("cloud-alt"\)/);

  const keyFile = configureDedicatedSpike('cloud-alt');
  process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ 'gpt-pro': keyFile });
  assert.throws(
    () => validateB1aEnv(),
    (error) => {
      assert.match(error.message, /extra cats \[gpt-pro\]/);
      assert.match(error.message, /no usable "cloud-alt" entry/);
      return true;
    },
  );

  configureDedicatedSpike('cloud-alt');
  process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({
    ...JSON.parse(process.env.CAT_CAFE_AGENT_KEY_FILES),
    codex: keyFile,
  });
  assert.throws(() => validateB1aEnv(), /extra cats \[codex\]/);
});

test('the cat id must be one that can hold a key file', () => {
  for (const catId of ['', '../escape', 'a..b', 'a/b', ' cloud-alt', '_hidden', 'x'.repeat(129)]) {
    configureDedicatedSpike('cloud-alt');
    process.env.CAT_CAFE_CAT_ID = catId;
    process.env.CAT_CAFE_AGENT_KEY_BOUND_CAT_ID = catId;
    assert.throws(() => validateB1aEnv(), /CAT_CAFE_CAT_ID must name the configured cloud cat/, JSON.stringify(catId));
  }
});

test('a configurable cloud cat keeps the mode and read-only gates', () => {
  configureDedicatedSpike('cloud-alt');
  process.env.CAT_CAFE_READONLY = 'false';
  assert.throws(() => validateB1aEnv(), /CAT_CAFE_READONLY must be "true"/);

  configureDedicatedSpike('cloud-alt');
  process.env.CAT_CAFE_DESKTOP_MODE = 'full';
  assert.throws(() => validateB1aEnv(), /CAT_CAFE_DESKTOP_MODE must be "cloud-pro-phase0"/);

  configureDedicatedSpike('cloud-alt');
  process.env.CAT_CAFE_INVOCATION_ID = 'inherited';
  assert.throws(() => validateB1aEnv(), /CAT_CAFE_INVOCATION_ID must be unset/);
});
