import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  planCodexAppServerThread,
  planCodexAppServerTurn,
} from '../src/domains/cats/services/agents/providers/codex-app-server-param-plan.js';

describe('Host validation for app-server params', () => {
  test('fills thread tokens only at their expected slots and keeps secrets Host-side', async () => {
    let seen;
    const plan = await planCodexAppServerThread(
      {
        kind: 'start',
        model: 'gpt-secret-model',
        cwd: '/secret/workspace',
        developerInstructions: 'L0 SECRET',
        config: { mcp_servers: { secret: { command: '/secret/mcp' } } },
        sandbox: 'read-only',
        approvalPolicy: 'never',
        serviceTier: 'fast',
        approvalsReviewer: 'auto_review',
      },
      async (request) => {
        seen = request;
        return {
          params: {
            ...(request.groups.model ? { model: request.groups.model } : {}),
            ...(request.groups.cwd ? { cwd: request.groups.cwd } : {}),
            ...(request.groups.developerInstructions
              ? { developerInstructions: request.groups.developerInstructions }
              : {}),
            ...(request.groups.config ? { config: request.groups.config } : {}),
            sandbox: request.options.sandbox,
            approvalPolicy: request.options.approvalPolicy,
            serviceTier: request.options.serviceTier,
            approvalsReviewer: request.options.approvalsReviewer,
          },
        };
      },
    );

    assert.equal(plan.params.model, 'gpt-secret-model');
    assert.equal(plan.params.cwd, '/secret/workspace');
    assert.equal(plan.params.developerInstructions, 'L0 SECRET');
    assert.deepEqual(plan.params.config, { mcp_servers: { secret: { command: '/secret/mcp' } } });
    const serialized = JSON.stringify(seen);
    assert.ok(!serialized.includes('gpt-secret-model'));
    assert.ok(!serialized.includes('L0 SECRET'));
    assert.ok(!serialized.includes('/secret/workspace'));
  });

  test('rejects a token moved to another key or an extra argument', async () => {
    const source = { kind: 'start', model: 'm', sandbox: 'read-only' };
    await assert.rejects(
      () =>
        planCodexAppServerThread(source, async (request) => ({
          params: { cwd: request.groups.model, sandbox: 'read-only' },
        })),
      /codex_app_server_plan_policy_violation/,
    );
    await assert.rejects(
      () =>
        planCodexAppServerThread(source, async (request) => ({
          params: { model: request.groups.model, sandbox: 'read-only', extra: true },
        })),
      /codex_app_server_plan_policy_violation/,
    );
  });

  test('resume startParams may not carry threadId or excludeTurns', async () => {
    await assert.rejects(
      () =>
        planCodexAppServerThread({ kind: 'resume', threadId: 'thread-1', model: 'm' }, async (request) => ({
          params: { threadId: request.groups.threadId, excludeTurns: true, model: request.groups.model },
          startParams: { threadId: request.groups.threadId, model: request.groups.model },
        })),
      /codex_app_server_plan_policy_violation/,
    );
  });

  test('turn fills text/images and rejects a prompt token moved into an image path', async () => {
    let seen;
    const plan = await planCodexAppServerTurn(
      {
        threadId: 'thread-1',
        clientUserMessageId: 'client-1',
        prompt: 'secret prompt',
        imagePaths: ['/secret/a.png'],
        outputSchema: { type: 'object' },
      },
      async (request) => {
        seen = request;
        return {
          params: {
            threadId: request.groups.threadId,
            clientUserMessageId: request.groups.clientUserMessageId,
            input: [
              { type: 'text', text: request.groups.prompt },
              { type: 'localImage', path: request.groups.images[0] },
            ],
            outputSchema: request.groups.outputSchema,
          },
        };
      },
    );

    assert.equal(plan.params.threadId, 'thread-1');
    assert.equal(plan.params.clientUserMessageId, 'client-1');
    assert.deepEqual(plan.params.input, [
      { type: 'text', text: 'secret prompt' },
      { type: 'localImage', path: '/secret/a.png' },
    ]);
    assert.deepEqual(plan.params.outputSchema, { type: 'object' });
    const serialized = JSON.stringify(seen);
    assert.ok(!serialized.includes('secret prompt'));
    assert.ok(!serialized.includes('/secret/a.png'));

    await assert.rejects(
      () =>
        planCodexAppServerTurn({ threadId: 'thread-1', prompt: 'p', imagePaths: ['/i.png'] }, async (request) => ({
          params: {
            threadId: request.groups.threadId,
            input: [{ type: 'localImage', path: request.groups.prompt }],
          },
        })),
      /codex_app_server_plan_policy_violation/,
    );
  });
});
