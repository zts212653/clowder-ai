import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  handleLimbInvoke,
  handleLimbListAvailable,
  handleLimbPairList,
  limbInvokeInputSchema,
  limbListAvailableInputSchema,
  limbPairApproveInputSchema,
  limbPairListInputSchema,
  limbTools,
} from '../dist/tools/limb-tools.js';

describe('limb-tools schema', () => {
  it('limbListAvailableInputSchema has correct shape', () => {
    assert.equal(limbListAvailableInputSchema.type, 'object');
    assert.ok(limbListAvailableInputSchema.properties.capability);
    assert.ok(limbListAvailableInputSchema.properties.agentKeyCatId);
  });

  it('limbInvokeInputSchema has required fields', () => {
    assert.equal(limbInvokeInputSchema.type, 'object');
    assert.ok(limbInvokeInputSchema.properties.nodeId);
    assert.ok(limbInvokeInputSchema.properties.command);
    assert.ok(limbInvokeInputSchema.properties.agentKeyCatId);
    assert.deepEqual(limbInvokeInputSchema.required, ['nodeId', 'command']);
  });

  it('pairing schemas expose agentKeyCatId for shared Antigravity MCP', () => {
    assert.equal(limbPairListInputSchema.type, 'object');
    assert.ok(limbPairListInputSchema.properties.agentKeyCatId);
    assert.equal(limbPairApproveInputSchema.type, 'object');
    assert.ok(limbPairApproveInputSchema.properties.agentKeyCatId);
  });

  it('limbTools array has 4 tools', () => {
    assert.equal(limbTools.length, 4);
    assert.equal(limbTools[0].name, 'limb_list_available');
    assert.equal(limbTools[1].name, 'limb_invoke');
    assert.equal(limbTools[2].name, 'limb_pair_list');
    assert.equal(limbTools[3].name, 'limb_pair_approve');
  });

  it('each tool has name, description, inputSchema, handler', () => {
    for (const tool of limbTools) {
      assert.ok(tool.name, 'missing name');
      assert.ok(tool.description, 'missing description');
      assert.ok(tool.inputSchema, 'missing inputSchema');
      assert.equal(typeof tool.handler, 'function', 'handler must be function');
    }
  });
});

describe('limb-tools handlers (no callback config)', () => {
  const origEnv = {};

  beforeEach(() => {
    // Clear callback env vars so handlers return error
    for (const key of ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN']) {
      origEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env
    for (const [key, val] of Object.entries(origEnv)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  });

  it('handleLimbListAvailable returns error without config', async () => {
    const result = await handleLimbListAvailable({});
    assert.ok(result.content);
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('not configured'));
  });

  it('handleLimbInvoke returns error without config', async () => {
    const result = await handleLimbInvoke({
      nodeId: 'test',
      command: 'test.cmd',
    });
    assert.ok(result.content);
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('not configured'));
  });
});

describe('limb-tools handlers (shared Antigravity agent-key path)', () => {
  const origEnv = {};
  let originalFetch;
  let secretPath;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    for (const key of [
      'CAT_CAFE_API_URL',
      'CAT_CAFE_INVOCATION_ID',
      'CAT_CAFE_CALLBACK_TOKEN',
      'CAT_CAFE_AGENT_KEY_SECRET',
      'CAT_CAFE_AGENT_KEY_FILE',
      'CAT_CAFE_AGENT_KEY_FILES',
      'CAT_CAFE_CALLBACK_RETRY_DELAYS_MS',
    ]) {
      origEnv[key] = process.env[key];
    }
    secretPath = join(tmpdir(), `limb-agent-key-${Date.now()}.secret`);
    writeFileSync(secretPath, 'variant-secret\n', { mode: 0o600 });
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_SECRET;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    process.env.CAT_CAFE_AGENT_KEY_FILES = JSON.stringify({ 'antig-opus': secretPath });
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    unlinkSync(secretPath);
    for (const [key, val] of Object.entries(origEnv)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  });

  it('handleLimbPairList uses variant-scoped agent-key when agentKeyCatId is provided', async () => {
    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      };
    };

    const result = await handleLimbPairList({ agentKeyCatId: 'antig-opus' });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl.includes('/api/callback/limb/pair/list'));
    assert.equal(capturedOptions.headers['x-agent-key-secret'], 'variant-secret');
  });
});
