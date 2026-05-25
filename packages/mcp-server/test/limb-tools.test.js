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
    assert.ok(limbListAvailableInputSchema.capability.isOptional());
    assert.ok(limbListAvailableInputSchema.agentKeyCatId.isOptional());
  });

  it('limbInvokeInputSchema has required fields', () => {
    assert.ok(limbInvokeInputSchema.nodeId.safeParse('weixin-mp').success);
    assert.ok(limbInvokeInputSchema.command.safeParse('weixin_mp.check_status').success);
    assert.equal(limbInvokeInputSchema.nodeId.safeParse('').success, false);
    assert.equal(limbInvokeInputSchema.command.safeParse('').success, false);
    assert.ok(limbInvokeInputSchema.params.isOptional());
    assert.ok(limbInvokeInputSchema.agentKeyCatId.isOptional());
  });

  it('pairing schemas expose agentKeyCatId for shared Antigravity MCP', () => {
    assert.ok(limbPairListInputSchema.agentKeyCatId.isOptional());
    assert.ok(limbPairApproveInputSchema.requestId.safeParse('pair-1').success);
    assert.equal(limbPairApproveInputSchema.requestId.safeParse('').success, false);
    assert.ok(limbPairApproveInputSchema.agentKeyCatId.isOptional());
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

  it('limb_invoke schema is a Zod raw shape, not a JSON Schema wrapper', () => {
    const invokeTool = limbTools.find((tool) => tool.name === 'limb_invoke');
    assert.ok(invokeTool);
    assert.deepEqual(Object.keys(invokeTool.inputSchema), ['nodeId', 'command', 'params', 'agentKeyCatId']);
    assert.ok(invokeTool.inputSchema.nodeId.safeParse('weixin-mp').success);
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
