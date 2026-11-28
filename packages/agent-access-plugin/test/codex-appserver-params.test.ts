import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildCodexAppServerThreadParams,
  buildCodexAppServerTurnParams,
} from '../src/runtime/codex-appserver-params.ts';

const token = (role: string) => `__CAT_CAFE_CODEX_AS_${role}__`;

describe('Codex app-server params', () => {
  test('start thread params keep opaque values at the expected keys', () => {
    const { params, startParams } = buildCodexAppServerThreadParams({
      operation: 'plan_app_server_thread',
      client: 'codex',
      kind: 'start',
      groups: {
        model: token('model'),
        cwd: token('cwd'),
        developerInstructions: token('developer'),
        config: token('config'),
      },
      options: {
        sandbox: 'read-only',
        approvalPolicy: 'never',
        serviceTier: 'fast',
        approvalsReviewer: 'auto_review',
      },
    });

    assert.deepEqual(params, {
      model: token('model'),
      cwd: token('cwd'),
      developerInstructions: token('developer'),
      config: token('config'),
      sandbox: 'read-only',
      approvalPolicy: 'never',
      serviceTier: 'fast',
      approvalsReviewer: 'auto_review',
    });
    assert.equal(startParams, undefined);
  });

  test('resume thread params split threadId/excludeTurns from startParams', () => {
    const { params, startParams } = buildCodexAppServerThreadParams({
      operation: 'plan_app_server_thread',
      client: 'codex',
      kind: 'resume',
      groups: { threadId: token('thread'), model: token('model') },
      options: { sandbox: 'workspace-write' },
    });

    assert.equal(params.threadId, token('thread'));
    assert.equal(params.excludeTurns, true);
    assert.equal(startParams?.threadId, undefined);
    assert.equal(startParams?.excludeTurns, undefined);
    assert.equal(startParams?.model, token('model'));
    assert.equal(startParams?.sandbox, 'workspace-write');
  });

  test('turn params build text/image input and opaque context', () => {
    const { params } = buildCodexAppServerTurnParams({
      operation: 'plan_app_server_turn',
      client: 'codex',
      groups: {
        threadId: token('thread'),
        clientUserMessageId: token('client'),
        prompt: token('prompt'),
        images: [token('image0'), token('image1')],
        recoveryContext: token('recovery'),
        outputSchema: token('schema'),
        collaborationMode: token('collab'),
      },
    });

    assert.equal(params.threadId, token('thread'));
    assert.equal(params.clientUserMessageId, token('client'));
    assert.deepEqual(params.input, [
      { type: 'text', text: token('prompt') },
      { type: 'localImage', path: token('image0') },
      { type: 'localImage', path: token('image1') },
    ]);
    assert.deepEqual(params.additionalContext, {
      'cat-cafe.capacity-recovery': { kind: 'application', value: token('recovery') },
    });
    assert.equal(params.outputSchema, token('schema'));
    assert.equal(params.collaborationMode, token('collab'));
  });
});
