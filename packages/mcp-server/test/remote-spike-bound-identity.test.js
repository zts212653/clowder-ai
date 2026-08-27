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

function configureDedicatedSpike() {
  const root = mkdtempSync(join(tmpdir(), 'f247-bound-spike-'));
  tempRoots.push(root);
  const keyFile = join(root, 'gpt-pro.secret');
  writeFileSync(keyFile, 'test-agent-key\n', { mode: 0o600 });
  Object.assign(process.env, {
    CAT_CAFE_REMOTE_TOKEN: 'test-remote-token',
    CAT_CAFE_DESKTOP_MODE: 'cloud-pro-phase0',
    CAT_CAFE_READONLY: 'true',
    CAT_CAFE_CAT_ID: 'gpt-pro',
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
    CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ 'gpt-pro': keyFile }),
    CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
  });
  delete process.env.CAT_CAFE_INVOCATION_ID;
  delete process.env.CAT_CAFE_CALLBACK_TOKEN;
  delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
}

test('dedicated Remote MCP validates its service-bound gpt-pro principal', () => {
  configureDedicatedSpike();
  assert.doesNotThrow(() => validateB1aEnv());
});

test('dedicated Remote MCP fails closed when its service-bound principal is absent', () => {
  configureDedicatedSpike();
  delete process.env.CAT_CAFE_AGENT_KEY_BOUND_CAT_ID;
  assert.throws(() => validateB1aEnv(), /CAT_CAFE_AGENT_KEY_BOUND_CAT_ID must be "gpt-pro"/);
});
