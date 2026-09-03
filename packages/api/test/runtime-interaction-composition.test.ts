import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeInteractionRecord, RuntimeInteractionRequest } from '@cat-cafe/shared';
import { emitRuntimeInteractionRecordUpdate } from '../src/domains/runtime-interaction/runtime-interaction-composition.js';

const owner = { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', invocationId: 'inv-1' };
const provider = {
  providerId: 'openai',
  method: 'item/commandExecution/requestApproval',
  requestId: 'rpc-1',
  threadId: 'provider-thread',
  turnId: 'provider-turn',
  itemId: 'provider-item',
};

function approval(): RuntimeInteractionRequest {
  return {
    version: 1,
    interactionId: 'interaction-1',
    kind: 'approval',
    owner,
    provider,
    createdAt: 1000,
    title: 'Run command?',
    decisions: [{ id: 'decline', label: 'Decline', outcome: 'decline' }],
  };
}

function record(
  request: RuntimeInteractionRequest,
  status: RuntimeInteractionRecord['status'],
): RuntimeInteractionRecord {
  return { request, status, hostEpoch: 'host-1', updatedAt: 2000 };
}

describe('runtime interaction production composition', () => {
  it('invalidates the canonical card and Approval Hub for approval records', () => {
    const events: Array<{ userId: string; event: string; data: unknown }> = [];
    const socket = {
      emitToUser: (userId: string, event: string, data: unknown) => events.push({ userId, event, data }),
    };

    emitRuntimeInteractionRecordUpdate(socket, record(approval(), 'pending'));
    emitRuntimeInteractionRecordUpdate(socket, record(approval(), 'declined'));

    assert.deepEqual(events, [
      {
        userId: 'user-1',
        event: 'runtime_interaction_updated',
        data: { interactionId: 'interaction-1', status: 'pending' },
      },
      {
        userId: 'user-1',
        event: 'proposal_created',
        data: { proposalId: 'interaction-1', featureId: 'F306', status: 'pending' },
      },
      {
        userId: 'user-1',
        event: 'runtime_interaction_updated',
        data: { interactionId: 'interaction-1', status: 'declined' },
      },
      {
        userId: 'user-1',
        event: 'proposal_updated',
        data: { proposalId: 'interaction-1', featureId: 'F306', status: 'declined' },
      },
    ]);
  });

  it('keeps non-approval interactions out of Approval Hub', () => {
    const events: Array<{ event: string }> = [];
    const socket = {
      emitToUser: (_userId: string, event: string) => events.push({ event }),
    };
    const question: RuntimeInteractionRequest = {
      version: 1,
      interactionId: 'question-1',
      kind: 'question',
      owner,
      provider: { ...provider, method: 'item/tool/requestUserInput' },
      createdAt: 1000,
      title: 'Choose environment',
      questions: [{ id: 'environment', header: 'Environment', question: 'Where?' }],
    };

    emitRuntimeInteractionRecordUpdate(socket, record(question, 'pending'));
    assert.deepEqual(events, [{ event: 'runtime_interaction_updated' }]);
  });
});
