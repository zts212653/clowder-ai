// @ts-check

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { getCallbackConfig } = await import(
  join(dirname(fileURLToPath(import.meta.url)), '../../../mcp-server/dist/tools/callback-tools.js')
);
const { resolveInvocationCredentials } = await import(
  join(dirname(fileURLToPath(import.meta.url)), '../../../mcp-server/dist/tools/invocation-auth.js')
);

describe('DSH family MCP callback credentials', () => {
  it('getCallbackConfig is live from overlay CAT_CAFE_CREDENTIAL_FILE, not process invocation env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-callback-'));
    const credPath = join(dir, 'dsh-dsh.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(credPath, JSON.stringify({ invocationId: 'inv-dsh-1', callbackToken: 'tok-dsh-1', ts: Date.now() }));

    const prev = {
      CAT_CAFE_API_URL: process.env.CAT_CAFE_API_URL,
      CAT_CAFE_CREDENTIAL_FILE: process.env.CAT_CAFE_CREDENTIAL_FILE,
      CAT_CAFE_INVOCATION_ID: process.env.CAT_CAFE_INVOCATION_ID,
      CAT_CAFE_CALLBACK_TOKEN: process.env.CAT_CAFE_CALLBACK_TOKEN,
      CAT_CAFE_AGENT_KEY_FILE: process.env.CAT_CAFE_AGENT_KEY_FILE,
      CAT_CAFE_AGENT_KEY_SECRET: process.env.CAT_CAFE_AGENT_KEY_SECRET,
      CAT_CAFE_AGENT_KEY_FILES: process.env.CAT_CAFE_AGENT_KEY_FILES,
    };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:9';
    process.env.CAT_CAFE_CREDENTIAL_FILE = credPath;
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_AGENT_KEY_FILES;
    try {
      const creds = resolveInvocationCredentials();
      assert.equal(creds.invocationId, 'inv-dsh-1');
      assert.equal(creds.callbackToken, 'tok-dsh-1');
      const cfg = getCallbackConfig();
      assert.ok(cfg, 'callback config must not be null when credential file is present');
      assert.equal(cfg.apiUrl, 'http://127.0.0.1:9');
      assert.equal(cfg.invocationId, 'inv-dsh-1');
      assert.equal(cfg.callbackToken, 'tok-dsh-1');
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('old continuable turn cannot read the next invocation token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-mcp-isolate-'));
    const oldPath = join(dir, 'dsh-old.json');
    const newPath = join(dir, 'dsh-new.json');
    writeFileSync(oldPath, JSON.stringify({ invocationId: 'inv-old', callbackToken: 'tok-old', ts: 1 }));
    writeFileSync(newPath, JSON.stringify({ invocationId: 'inv-new', callbackToken: 'tok-new', ts: 2 }));

    const prev = {
      CAT_CAFE_API_URL: process.env.CAT_CAFE_API_URL,
      CAT_CAFE_CREDENTIAL_FILE: process.env.CAT_CAFE_CREDENTIAL_FILE,
      CAT_CAFE_INVOCATION_ID: process.env.CAT_CAFE_INVOCATION_ID,
      CAT_CAFE_CALLBACK_TOKEN: process.env.CAT_CAFE_CALLBACK_TOKEN,
      CAT_CAFE_AGENT_KEY_FILE: process.env.CAT_CAFE_AGENT_KEY_FILE,
      CAT_CAFE_AGENT_KEY_SECRET: process.env.CAT_CAFE_AGENT_KEY_SECRET,
      CAT_CAFE_AGENT_KEY_FILES: process.env.CAT_CAFE_AGENT_KEY_FILES,
    };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:9';
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_AGENT_KEY_FILES;
    try {
      process.env.CAT_CAFE_CREDENTIAL_FILE = oldPath;
      const oldCfg = getCallbackConfig();
      process.env.CAT_CAFE_CREDENTIAL_FILE = newPath;
      const newCfg = getCallbackConfig();
      process.env.CAT_CAFE_CREDENTIAL_FILE = oldPath;
      const oldAfter = getCallbackConfig();
      assert.equal(oldCfg?.invocationId, 'inv-old');
      assert.equal(newCfg?.invocationId, 'inv-new');
      assert.equal(oldAfter?.invocationId, 'inv-old');
      assert.equal(oldAfter?.callbackToken, 'tok-old');
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('getCallbackConfig is null without credential file or agent key', () => {
    const prev = {
      CAT_CAFE_API_URL: process.env.CAT_CAFE_API_URL,
      CAT_CAFE_CREDENTIAL_FILE: process.env.CAT_CAFE_CREDENTIAL_FILE,
      CAT_CAFE_INVOCATION_ID: process.env.CAT_CAFE_INVOCATION_ID,
      CAT_CAFE_CALLBACK_TOKEN: process.env.CAT_CAFE_CALLBACK_TOKEN,
      CAT_CAFE_AGENT_KEY_FILE: process.env.CAT_CAFE_AGENT_KEY_FILE,
      CAT_CAFE_AGENT_KEY_SECRET: process.env.CAT_CAFE_AGENT_KEY_SECRET,
      CAT_CAFE_AGENT_KEY_FILES: process.env.CAT_CAFE_AGENT_KEY_FILES,
    };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:9';
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_AGENT_KEY_FILES;
    try {
      assert.equal(getCallbackConfig(), null);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
