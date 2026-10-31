import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeInteractionRequest, RuntimeInteractionResponse } from '@cat-cafe/shared';
import { respondToCodexRuntimeInteraction } from '../src/domains/cats/services/agents/providers/CodexRuntimeInteractionAdapter.js';
import { RuntimeInteractionError } from '../src/domains/runtime-interaction/RuntimeInteractionService.js';

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

describe('Codex runtime interaction wire edges', () => {
  it('normalizes an upstream empty question option list into a free-form question', async () => {
    const { requests, context } = harness(() => ({
      kind: 'answers',
      answers: { destination: ['Free-form destination'] },
    }));
    const response = await respondToCodexRuntimeInteraction(
      {
        id: 431,
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'provider-thread',
          turnId: 'provider-turn',
          itemId: 'question-item-empty-options',
          isBlocking: true,
          questions: [
            {
              id: 'destination',
              header: 'Destination',
              question: 'Where should this go?',
              options: [],
            },
          ],
        },
      },
      context,
    );

    assert.deepEqual(response, {
      id: 431,
      result: { answers: { destination: { answers: ['Free-form destination'] } } },
    });
    const question = requests[0]?.kind === 'question' ? requests[0].questions[0] : undefined;
    assert.ok(question);
    assert.equal(Object.hasOwn(question, 'options'), false);
  });

  it('fails closed before publication for missing or non-blocking request-user-input semantics', async () => {
    for (const isBlocking of [undefined, false]) {
      const invalid = harness(() => ({ kind: 'answers', answers: { destination: ['Alpha'] } }));
      const response = await respondToCodexRuntimeInteraction(
        {
          id: isBlocking === false ? 433 : 432,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'provider-thread',
            turnId: 'provider-turn',
            itemId: 'question-item-blocking-contract',
            ...(isBlocking === undefined ? {} : { isBlocking }),
            questions: [{ id: 'destination', header: 'Destination', question: 'Where?' }],
          },
        },
        invalid.context,
      );
      assert.equal((response?.error as { code?: number })?.code, -32602);
      assert.equal(invalid.requests.length, 0);
    }
  });

  it('accepts upstream advisory MCP form keywords without leaking them into the canonical schema', async () => {
    const { requests, context } = harness(() => ({
      kind: 'decision',
      decisionId: 'accept',
      content: { contact: 'owner@example.com', region: 'us-west' },
    }));
    const response = await respondToCodexRuntimeInteraction(
      {
        id: 451,
        method: 'mcpServer/elicitation/request',
        params: {
          serverName: 'deployment-mcp',
          threadId: 'provider-thread',
          turnId: null,
          mode: 'form',
          message: 'Choose deployment settings',
          requestedSchema: {
            type: 'object',
            properties: {
              contact: { type: 'string', title: 'Contact', format: 'email' },
              region: {
                type: 'string',
                title: 'Region',
                enum: ['us-west', 'us-east'],
                enumNames: ['US West', 'US East'],
              },
            },
            required: ['contact', 'region'],
          },
        },
      },
      context,
    );

    assert.deepEqual(response, {
      id: 451,
      result: { action: 'accept', content: { contact: 'owner@example.com', region: 'us-west' } },
    });
    const request = requests[0];
    assert.equal(request?.kind, 'elicitation');
    if (request?.kind !== 'elicitation' || request.mode !== 'form') return;
    assert.deepEqual(request.requestedSchema.properties.contact, { type: 'string', title: 'Contact' });
    assert.deepEqual(request.requestedSchema.properties.region, {
      type: 'string',
      title: 'Region',
      enum: ['us-west', 'us-east'],
    });
  });

  it('fails closed on unsupported schema and exposes transport loss without claiming user rejection', async () => {
    const unsupported = harness(() => ({ kind: 'decision', decisionId: 'accept' }));
    const invalidResponse = await respondToCodexRuntimeInteraction(
      {
        id: 46,
        method: 'mcpServer/elicitation/request',
        params: {
          serverName: 'unsafe-mcp',
          threadId: 'provider-thread',
          mode: 'form',
          message: 'Nested object',
          requestedSchema: {
            type: 'object',
            properties: { nested: { type: 'object', properties: {} } },
          },
        },
      },
      unsupported.context,
    );
    assert.equal((invalidResponse?.error as { code?: number })?.code, -32602);
    assert.equal(unsupported.requests.length, 0);

    for (const requestedSchema of [
      {
        type: 'object',
        properties: {
          regions: { type: 'array', items: { type: 'string', enum: ['us-west', 'us-east'] } },
        },
      },
      {
        type: 'object',
        properties: {
          region: {
            type: 'string',
            oneOf: [
              { const: 'us-west', title: 'US West' },
              { const: 'us-east', title: 'US East' },
            ],
          },
        },
      },
    ]) {
      const semanticUnsupported = harness(() => ({ kind: 'decision', decisionId: 'accept' }));
      const response = await respondToCodexRuntimeInteraction(
        {
          id: 461,
          method: 'mcpServer/elicitation/request',
          params: {
            serverName: 'semantic-mcp',
            threadId: 'provider-thread',
            mode: 'form',
            message: 'Choose regions',
            requestedSchema,
          },
        },
        semanticUnsupported.context,
      );
      assert.equal((response?.error as { code?: number })?.code, -32602);
      assert.equal(semanticUnsupported.requests.length, 0);
    }

    const unavailable = harness(async () => {
      throw new RuntimeInteractionError('stale', 'transport_lost', 'transport_lost');
    });
    const transportResponse = await respondToCodexRuntimeInteraction(
      {
        id: 47,
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'provider-thread',
          turnId: 'provider-turn',
          itemId: 'file-item',
          startedAtMs: 1777000000002,
        },
      },
      unavailable.context,
    );
    assert.deepEqual(transportResponse, {
      id: 47,
      error: {
        code: -32001,
        message: 'Runtime interaction unavailable',
        data: { reasonCode: 'transport_lost' },
      },
    });

    const confirmationUnavailable = harness(async () => {
      throw new RuntimeInteractionError('unavailable', 'confirmation_unavailable', 'confirmation_unavailable');
    });
    const unavailableResponse = await respondToCodexRuntimeInteraction(
      {
        id: 48,
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'provider-thread',
          turnId: 'provider-turn',
          itemId: 'file-item',
          startedAtMs: 1777000000003,
        },
      },
      confirmationUnavailable.context,
    );
    assert.deepEqual(unavailableResponse, {
      id: 48,
      error: {
        code: -32001,
        message: 'Runtime interaction unavailable',
        data: { reasonCode: 'confirmation_unavailable' },
      },
    });
  });
});
