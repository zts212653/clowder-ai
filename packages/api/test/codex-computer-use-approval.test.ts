import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeInteractionRequest, RuntimeInteractionResponse } from '@cat-cafe/shared';
import { parseRuntimeInteractionRequest, parseRuntimeInteractionResponse } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { respondToCodexRuntimeInteraction } from '../src/domains/cats/services/agents/providers/CodexRuntimeInteractionAdapter.js';
import { RuntimeInteractionService } from '../src/domains/runtime-interaction/RuntimeInteractionService.js';
import { InMemoryRuntimeInteractionStore } from '../src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';
import { runtimeInteractionRoutes } from '../src/routes/runtime-interaction-routes.js';

const owner = {
  userId: 'user-1',
  threadId: 'cat-thread-1',
  catId: 'codex-sol',
  invocationId: 'invocation-1',
};

function harness(
  respond: (request: RuntimeInteractionRequest) => RuntimeInteractionResponse | Promise<RuntimeInteractionResponse>,
) {
  const requests: RuntimeInteractionRequest[] = [];
  return {
    requests,
    context: {
      owner,
      createInteractionId: () => `interaction-${requests.length + 1}`,
      port: {
        request: async (request: RuntimeInteractionRequest) => {
          requests.push(request);
          return respond(request);
        },
      },
    },
  };
}

describe('Codex Computer Use app approval persistence', () => {
  it('offers only native Computer Use persistence choices and returns the explicit user choice', async () => {
    for (const persist of ['session', 'always'] as const) {
      const decisionId = persist === 'session' ? 'acceptForSession' : 'acceptAlways';
      const { requests, context } = harness((request) => {
        const admitted = parseRuntimeInteractionRequest(request);
        assert.equal(admitted.kind, 'elicitation');
        return parseRuntimeInteractionResponse(admitted, { kind: 'decision', decisionId, content: {} });
      });
      const response = await respondToCodexRuntimeInteraction(computerUseRequest(['session', 'always']), context);
      assert.equal(requests.length, 1, 'the adapter must still request a real user decision');
      assert.deepEqual(
        requests[0].decisions.map(({ id }) => id),
        ['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel'],
      );
      assert.deepEqual(response, { id: 49, result: { action: 'accept', content: {}, _meta: { persist } } });
    }
  });

  it('does not grant unoffered persistence or convert ordinary forms into persistent approvals', async () => {
    for (const input of [
      computerUseRequest(['session']),
      computerUseRequest([], { persist: ['always'], connector_id: 'another-connector' }),
      {
        ...computerUseRequest(['always']),
        params: { ...computerUseRequest(['always']).params, serverName: 'another-server' },
      },
      computerUseRequest([], { persist: ['global'] }),
      computerUseRequest([], { persist: ['always', 'global'] }),
      computerUseRequest(['always'], { tool_params: { app: ' ' } }),
      computerUseRequest(['always'], { tool_params: { url: 'https://example.com' } }),
      computerUseRequest(['always'], { codex_approval_kind: 'another-kind' }),
      computerUseRequest(['always'], { tool_name: '' }),
      computerUseRequest(['always'], { persist: 'always' }),
    ]) {
      const { context } = harness((request) => {
        assert.ok(!request.decisions.some(({ id }) => id === 'acceptAlways'));
        return { kind: 'decision', decisionId: 'acceptAlways', content: {} };
      });
      assert.equal((await respondToCodexRuntimeInteraction(input, context))?.error?.code, -32602);
    }
  });

  it('does not attach persistence to refusal or an ordinary one-time Computer Use response', async () => {
    for (const decisionId of ['accept', 'decline', 'cancel']) {
      const { context } = harness(() => ({
        kind: 'decision',
        decisionId,
        ...(decisionId === 'accept' ? { content: {} } : {}),
      }));
      assert.deepEqual(await respondToCodexRuntimeInteraction(computerUseRequest(['session', 'always']), context), {
        id: 49,
        result: { action: decisionId, ...(decisionId === 'accept' ? { content: {} } : {}) },
      });
    }
  });

  it('deduplicates offered scopes and never adds an absent scope', async () => {
    for (const persist of [[], ['session'], ['always'], ['always', 'always']] as const) {
      const { requests, context } = harness(() => ({ kind: 'decision', decisionId: 'cancel' }));
      await respondToCodexRuntimeInteraction(computerUseRequest(persist), context);
      assert.deepEqual(
        requests[0].decisions.map(({ id }) => id),
        [
          'accept',
          ...(persist.some((scope) => scope === 'session') ? ['acceptForSession'] : []),
          ...(persist.some((scope) => scope === 'always') ? ['acceptAlways'] : []),
          'decline',
          'cancel',
        ],
      );
    }
  });

  it('keeps generic forms and URL elicitation on the one-time response contract', async () => {
    const input = computerUseRequest(['session', 'always']);
    for (const params of [
      { ...input.params, _meta: undefined },
      { ...input.params, mode: 'url', elicitationId: 'url-1', url: 'https://example.com' },
    ]) {
      const { requests, context } = harness(() => ({ kind: 'decision', decisionId: 'acceptAlways' }));
      assert.equal((await respondToCodexRuntimeInteraction({ ...input, params }, context))?.error?.code, -32602);
      assert.deepEqual(
        requests[0].decisions.map(({ id }) => id),
        ['accept', 'decline', 'cancel'],
      );
    }
  });

  it('round-trips an explicit HTTP choice through the canonical service without weakening ownership or replay checks', async () => {
    const app = Fastify();
    const cardRef = { threadId: owner.threadId, messageId: 'message-1', blockId: 'runtime-interaction:cua-1' };
    let publishPending: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      publishPending = resolve;
    });
    let providerSettled = false;
    const service = new RuntimeInteractionService({
      store: new InMemoryRuntimeInteractionStore(),
      hostEpoch: 'isolated-test-host',
      cardPublisher: { publish: async () => cardRef, isLive: async () => true },
      onRecordUpdated: (record) => {
        if (record.status === 'pending') publishPending();
      },
    });
    await app.register(runtimeInteractionRoutes, { service });
    const providerResponse = respondToCodexRuntimeInteraction(computerUseRequest(['always']), {
      owner,
      port: service,
      createInteractionId: () => 'cua-1',
    }).then((response) => {
      providerSettled = true;
      return response;
    });
    try {
      await pending;
      assert.equal(providerSettled, false, 'offering persistence must not auto-approve');
      const url = '/api/runtime-interactions/cua-1/respond';
      const payload = { cardRef, response: { kind: 'decision', decisionId: 'acceptAlways', content: {} } };
      for (const [headers, body, status] of [
        [{}, payload, 401],
        [{ 'x-cat-cafe-user': 'other-user' }, payload, 404],
        [{ 'x-cat-cafe-user': owner.userId }, { ...payload, cardRef: { ...cardRef, messageId: 'copied' } }, 404],
        [
          { 'x-cat-cafe-user': owner.userId },
          { ...payload, response: { ...payload.response, decisionId: 'acceptForSession' } },
          400,
        ],
      ] as const) {
        assert.equal((await app.inject({ method: 'POST', url, headers, payload: body })).statusCode, status);
        assert.equal(providerSettled, false);
      }
      const headers = { 'x-cat-cafe-user': owner.userId };
      const accepted = await app.inject({ method: 'POST', url, headers, payload });
      assert.equal(accepted.statusCode, 200);
      assert.equal(accepted.json().interaction.status, 'answered');
      assert.equal(accepted.json().interaction.request.provider.requestId, 49);
      assert.deepEqual(await providerResponse, {
        id: 49,
        result: { action: 'accept', content: {}, _meta: { persist: 'always' } },
      });
      assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 409);
    } finally {
      await service.invalidateInvocation(owner.invocationId, 'provider_cancelled');
      await providerResponse;
      await app.close();
    }
  });
});

function computerUseRequest(persist: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    id: 49,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      serverName: 'cua_repl',
      mode: 'form',
      message: 'Allow Computer Use to use "Google Chrome"?',
      requestedSchema: { type: 'object', properties: {}, additionalProperties: false },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        connector_id: 'computer-use',
        connector_name: 'Computer Use',
        tool_name: 'get_app_state',
        tool_params: { app: 'com.google.Chrome' },
        persist,
        ...overrides,
      },
    },
  };
}
