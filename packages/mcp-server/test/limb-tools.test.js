import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  handleLimbInvoke,
  handleLimbListAvailable,
  limbInvokeInputSchema,
  limbListAvailableInputSchema,
  limbTools,
} from '../dist/tools/limb-tools.js';

describe('limb-tools schema', () => {
  it('limbListAvailableInputSchema has correct shape', () => {
    assert.equal(limbListAvailableInputSchema.type, 'object');
    assert.ok(limbListAvailableInputSchema.properties.capability);
  });

  it('limbInvokeInputSchema has required fields', () => {
    assert.equal(limbInvokeInputSchema.type, 'object');
    assert.ok(limbInvokeInputSchema.properties.nodeId);
    assert.ok(limbInvokeInputSchema.properties.command);
    assert.deepEqual(limbInvokeInputSchema.required, ['nodeId', 'command']);
  });

  it('limbTools array has 2 tools', () => {
    assert.equal(limbTools.length, 2);
    assert.equal(limbTools[0].name, 'limb_list_available');
    assert.equal(limbTools[1].name, 'limb_invoke');
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
