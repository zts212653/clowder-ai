import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EntrustedWorkTaskRefV1, RuntimeInteractionRequest, RuntimeInteractionResponse } from '@cat-cafe/shared';
import { respondToCodexRuntimeInteraction } from '../src/domains/cats/services/agents/providers/CodexRuntimeInteractionAdapter.js';

const owner = {
  userId: 'user-1',
  threadId: 'cat-thread-1',
  catId: 'codex-sol',
  invocationId: 'invocation-1',
};

function harness(
  respond: (request: RuntimeInteractionRequest) => RuntimeInteractionResponse | Promise<RuntimeInteractionResponse>,
  entrustedWorkTaskRef?: EntrustedWorkTaskRefV1,
) {
  const requests: RuntimeInteractionRequest[] = [];
  return {
    requests,
    context: {
      owner,
      createInteractionId: () => `interaction-${requests.length + 1}`,
      ...(entrustedWorkTaskRef ? { resolveEntrustedWorkTaskRef: async () => entrustedWorkTaskRef } : {}),
      port: {
        request: async (request: RuntimeInteractionRequest) => {
          requests.push(request);
          return respond(request);
        },
      },
    },
  };
}

describe('Codex runtime interaction adapter', () => {
  it('maps command approval decisions and exact provider identity through the shared port', async () => {
    const { requests, context } = harness(async (request) => {
      assert.deepEqual(
        request.decisions.map(({ id }) => id),
        [
          'accept',
          'acceptForSession',
          'acceptWithExecpolicyAmendment',
          'applyNetworkPolicyAmendment:0',
          'decline',
          'cancel',
        ],
      );
      return { kind: 'decision', decisionId: 'acceptWithExecpolicyAmendment' };
    });
    const response = await respondToCodexRuntimeInteraction(
      {
        id: 41,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'provider-thread',
          turnId: 'provider-turn',
          itemId: 'provider-item',
          startedAtMs: 1777000000000,
          command: 'pnpm test',
          cwd: '/workspace',
          reason: 'Run the focused tests',
          proposedExecpolicyAmendment: ['prefix_rule(pattern=["pnpm", "test"])'],
          proposedNetworkPolicyAmendments: [{ host: 'registry.npmjs.org', action: 'allow' }],
        },
      },
      context,
    );

    assert.deepEqual(response, {
      id: 41,
      result: {
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ['prefix_rule(pattern=["pnpm", "test"])'],
          },
        },
      },
    });
    assert.deepEqual(requests[0]?.owner, owner);
    assert.deepEqual(requests[0]?.provider, {
      providerId: 'openai',
      method: 'item/commandExecution/requestApproval',
      requestId: 41,
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'provider-item',
    });
  });

  it('maps file approval without inventing command-only choices', async () => {
    const { requests, context } = harness(() => ({ kind: 'decision', decisionId: 'acceptForSession' }));
    const response = await respondToCodexRuntimeInteraction(
      {
        id: 42,
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'provider-thread',
          turnId: 'provider-turn',
          itemId: 'file-item',
          startedAtMs: 1777000000001,
          reason: 'Apply patch',
          grantRoot: '/workspace/packages/api',
        },
      },
      context,
    );
    assert.deepEqual(requests[0]?.kind === 'approval' ? requests[0].decisions.map(({ id }) => id) : [], [
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ]);
    assert.deepEqual(response, { id: 42, result: { decision: 'acceptForSession' } });
  });

  it('maps all request-user-input answers back to the same turn and item', async () => {
    const { requests, context } = harness(
      () => ({
        kind: 'answers',
        answers: { environment: ['Alpha'], token: ['secret-value'] },
      }),
      {
        subjectRef: 'task:work:task-1',
        observedRevision: 3,
      },
    );
    const response = await respondToCodexRuntimeInteraction(
      {
        id: 43,
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'provider-thread',
          turnId: 'provider-turn',
          itemId: 'question-item',
          isBlocking: true,
          questions: [
            {
              id: 'environment',
              header: 'Environment',
              question: 'Where?',
              options: [{ label: 'Alpha', description: 'Isolated app' }],
            },
            { id: 'token', header: 'Token', question: 'One-time token?', isSecret: true },
          ],
        },
      },
      context,
    );
    assert.equal(requests[0]?.kind, 'question');
    assert.deepEqual(requests[0]?.entrustedWorkTaskRef, {
      subjectRef: 'task:work:task-1',
      observedRevision: 3,
    });
    assert.deepEqual(response, {
      id: 43,
      result: {
        answers: {
          environment: { answers: ['Alpha'] },
          token: { answers: ['secret-value'] },
        },
      },
    });
  });

  it('does not attach an entrusted Task to provider approval or elicitation records', async () => {
    const { requests, context } = harness(() => ({ kind: 'decision', decisionId: 'decline' }), {
      subjectRef: 'task:work:task-1',
      observedRevision: 3,
    });
    await respondToCodexRuntimeInteraction(
      {
        id: 52,
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'provider-thread',
          turnId: 'provider-turn',
          itemId: 'file-item',
          startedAtMs: 1777000000001,
          reason: 'Apply patch',
          grantRoot: '/workspace/packages/api',
        },
      },
      context,
    );
    assert.equal(requests[0]?.entrustedWorkTaskRef, undefined);
  });

  it('maps admitted MCP form and URL elicitation schemas without projecting approval items', async () => {
    const formHarness = harness((request) => {
      assert.equal(request.kind, 'elicitation');
      assert.equal(request.mode, 'form');
      return { kind: 'decision', decisionId: 'accept', content: { region: 'us-west', replicas: 2 } };
    });
    const formResponse = await respondToCodexRuntimeInteraction(
      {
        id: 44,
        method: 'mcpServer/elicitation/request',
        params: {
          serverName: 'deployment-mcp',
          threadId: 'provider-thread',
          turnId: 'provider-turn',
          mode: 'form',
          message: 'Choose deployment settings',
          requestedSchema: {
            type: 'object',
            properties: {
              region: { type: 'string', title: 'Region', enum: ['us-west', 'us-east'] },
              replicas: { type: 'integer', title: 'Replicas', minimum: 1 },
            },
            required: ['region', 'replicas'],
          },
        },
      },
      formHarness.context,
    );
    assert.deepEqual(formResponse, {
      id: 44,
      result: { action: 'accept', content: { region: 'us-west', replicas: 2 } },
    });

    const urlHarness = harness(() => ({ kind: 'decision', decisionId: 'decline' }));
    const urlResponse = await respondToCodexRuntimeInteraction(
      {
        id: 45,
        method: 'mcpServer/elicitation/request',
        params: {
          serverName: 'oauth-mcp',
          threadId: 'provider-thread',
          turnId: null,
          mode: 'url',
          message: 'Authorize access',
          elicitationId: 'elicit-1',
          url: 'https://example.com/authorize',
        },
      },
      urlHarness.context,
    );
    assert.deepEqual(urlResponse, { id: 45, result: { action: 'decline' } });
  });

  it('rejects provider requests missing exact thread, turn, or item coordinates before publication', async () => {
    const invalid = harness(() => ({ kind: 'decision', decisionId: 'accept' }));
    for (const params of [
      { turnId: 'provider-turn', itemId: 'file-item', startedAtMs: 1777000000004 },
      { threadId: 'provider-thread', itemId: 'file-item', startedAtMs: 1777000000004 },
      { threadId: 'provider-thread', turnId: 'provider-turn', startedAtMs: 1777000000004 },
    ]) {
      const response = await respondToCodexRuntimeInteraction(
        { id: 49, method: 'item/fileChange/requestApproval', params },
        invalid.context,
      );
      assert.equal((response?.error as { code?: number })?.code, -32602);
    }
    assert.equal(invalid.requests.length, 0);
  });

  it('leaves MCP approval compatibility questions on the existing synthetic decline path', async () => {
    const invalid = harness(() => ({ kind: 'answers', answers: {} }));
    assert.equal(
      await respondToCodexRuntimeInteraction(
        {
          id: 50,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'provider-thread',
            turnId: 'provider-turn',
            itemId: 'compat-approval',
            questions: [
              {
                id: 'mcp_tool_call_approval_1',
                header: 'MCP approval',
                question: 'Allow tool?',
                options: [],
              },
            ],
          },
        },
        invalid.context,
      ),
      null,
    );
    assert.equal(invalid.requests.length, 0);
  });

  it('returns null for non-Phase-B methods so the existing fail-closed responder remains authoritative', async () => {
    const unknown = harness(() => ({ kind: 'decision', decisionId: 'accept' }));
    assert.equal(
      await respondToCodexRuntimeInteraction(
        { id: 51, method: 'item/permissions/requestApproval', params: {} },
        unknown.context,
      ),
      null,
    );
    assert.equal(unknown.requests.length, 0);
  });
});
