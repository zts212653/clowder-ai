import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PluginLimbAdapter } from '../dist/domains/limb/PluginLimbAdapter.js';

const declaration = {
  nodeId: 'local-test-limb',
  displayName: 'Local Test Limb',
  platform: 'macos',
  capabilities: [{ cap: 'local_read', commands: ['local.read'], authLevel: 'leased' }],
  commands: {
    'local.read': {
      type: 'invoke',
      description: 'Read local state',
      params: {},
      handler: 'local-test:read',
    },
  },
};

describe('PluginLimbAdapter invocation context', () => {
  it('passes trusted callback provenance to a local invoke handler', async () => {
    let receivedContext;
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: {},
      handlers: {
        'local-test:read': async (_params, context) => {
          receivedContext = context.invocation;
          return { success: true };
        },
      },
    });
    const invocation = {
      catId: 'opus',
      invocationId: 'inv-123',
      userId: 'user-1',
      threadId: 'thread-1',
      userMessageId: 'msg-1',
    };

    const result = await adapter.invoke('local.read', {}, invocation);

    assert.equal(result.success, true);
    assert.deepEqual(receivedContext, invocation);
  });

  it('keeps invocation context optional for existing local handlers', async () => {
    let receivedContext;
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: {},
      handlers: {
        'local-test:read': async (_params, context) => {
          receivedContext = context.invocation;
          return { success: true };
        },
      },
    });

    const result = await adapter.invoke('local.read', {});

    assert.equal(result.success, true);
    assert.equal(receivedContext, undefined);
  });

  it('exposes handler-validated params as required while preserving typed handler refusal', async () => {
    const typedDeclaration = {
      ...declaration,
      commands: {
        'local.read': {
          ...declaration.commands['local.read'],
          params: {
            acknowledgeRisk: { type: 'boolean', required: true, validation: 'handler' },
          },
        },
      },
    };
    const adapter = new PluginLimbAdapter({
      declaration: typedDeclaration,
      pluginConfig: {},
      handlers: {
        'local-test:read': async (params) => ({
          success: true,
          data:
            params.acknowledgeRisk === true ? { ok: true } : { ok: false, error: { code: 'authorization_required' } },
        }),
      },
    });

    assert.equal(adapter.commandSchemas['local.read'].params.acknowledgeRisk.required, true);
    const result = await adapter.invoke('local.read', {});
    assert.equal(result.success, true);
    assert.equal(result.data.error.code, 'authorization_required');
  });
});
