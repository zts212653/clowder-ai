import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const READ_ONLY_POLICY = {
  mode: 'read_only',
  replayDeniedToolNames: ['mcp__cat-cafe-collab__cat_cafe_hold_ball'],
};

describe('F254 ADR-042 hard read-only tool policy', () => {
  it('normalizes provider aliases to one tool identity and preserves replay denial', async () => {
    const { normalizeToolExecutionName, toolExecutionPolicyDenial } = await import(
      '../dist/domains/cats/services/agents/invocation/tool-execution-policy.js'
    );

    const aliases = [
      'mcp__cat-cafe-collab__cat_cafe_hold_ball',
      'mcp:cat-cafe-collab/cat_cafe_hold_ball',
      'cat_cafe_hold_ball',
      'hold-ball',
    ];
    assert.deepEqual(aliases.map(normalizeToolExecutionName), Array(aliases.length).fill('cat_cafe_hold_ball'));
    for (const alias of aliases) {
      assert.deepEqual(toolExecutionPolicyDenial(READ_ONLY_POLICY, alias), {
        reason: 'replay_denied_tool',
        toolName: 'cat_cafe_hold_ball',
      });
    }
  });

  it('persists the normalized policy on invocation auth records', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const registry = new InvocationRegistry();
    const { invocationId, callbackToken } = await registry.create(
      'user-1',
      'opus',
      'thread-1',
      undefined,
      undefined,
      READ_ONLY_POLICY,
    );

    const verified = await registry.verify(invocationId, callbackToken);
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.record.toolExecutionPolicy, {
      mode: 'read_only',
      replayDeniedToolNames: ['cat_cafe_hold_ball'],
    });
  });

  it('rejects callback mutations before the route handler for a read-only invocation', async () => {
    const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
    let handled = false;
    const record = {
      invocationId: 'inv-read-only',
      callbackToken: 'tok-read-only',
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-1',
      clientMessageIds: new Set(),
      createdAt: 100,
      expiresAt: Date.now() + 60_000,
      toolExecutionPolicy: READ_ONLY_POLICY,
    };
    const app = Fastify({ logger: false });
    registerCallbackAuthHook(app, {
      async verify(invocationId, callbackToken) {
        return invocationId === record.invocationId && callbackToken === record.callbackToken
          ? { ok: true, record }
          : { ok: false, reason: 'invalid_token' };
      },
    });
    app.post('/api/callbacks/hold-ball', async () => {
      handled = true;
      return { ok: true };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: {
        'x-invocation-id': record.invocationId,
        'x-callback-token': record.callbackToken,
      },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'tool_policy_violation');
    assert.equal(response.json().tool, 'cat_cafe_hold_ball');
    assert.equal(handled, false);
    await app.close();
  });

  it('fails before registry allocation and model launch when the provider cannot enforce the policy', async () => {
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    let createCount = 0;
    let invokeCount = 0;
    const deps = {
      registry: {
        async create() {
          createCount += 1;
          return { invocationId: 'inv-should-not-exist', callbackToken: 'tok-should-not-exist' };
        },
      },
      sessionManager: {},
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };
    const unsupportedService = {
      async *invoke() {
        invokeCount += 1;
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    await assert.rejects(
      async () => {
        for await (const _message of invokeSingleCat(deps, {
          catId: 'opus',
          service: unsupportedService,
          prompt: 'supplement check',
          userId: 'user-1',
          threadId: 'thread-1',
          isLastCat: true,
          toolExecutionPolicy: READ_ONLY_POLICY,
        })) {
          // The capability gate must throw before yielding or launching.
        }
      },
      (error) => error?.code === 'read_only_tool_policy_unavailable',
    );
    assert.equal(createCount, 0);
    assert.equal(invokeCount, 0);
  });
});
