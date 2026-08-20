import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bindAsrPersonMemoryScenesFromQueueMessage } from '../../dist/domains/signal-intake/AsrPersonMemoryQueueCarrier.js';
import { artifact, intake } from './asr-person-memory-contract-fixture.js';

async function sceneAt(now) {
  const { buildAsrPersonMemoryDynamicScenes } = await import(
    '../../dist/domains/signal-intake/AsrPersonMemorySceneBuilder.js'
  );
  return buildAsrPersonMemoryDynamicScenes({
    intake: { ...intake, updatedAt: now - 10 },
    artifact,
    threadId: 'thread-1',
    consumerCatId: 'codex',
    now,
  })[0];
}

function message(scene, overrides = {}) {
  return {
    id: 'message-meeting-1',
    threadId: 'thread-1',
    userId: 'owner-1',
    catId: null,
    content: 'data-only meeting carrier',
    timestamp: Date.now(),
    extra: {
      meetingArtifact: {
        intakeId: 'meeting-1',
        sourceHandle: 'meeting://source-1',
        trust: 'untrusted_external',
        instructionPolicy: 'data_only',
      },
      dynamicSceneEntries: [scene],
    },
    ...overrides,
  };
}

describe('ASR → F276 Queue carrier boundary', () => {
  it('binds source coordinates only from the exact live owner message', async () => {
    const scene = await sceneAt(Date.now());
    assert.deepEqual(
      bindAsrPersonMemoryScenesFromQueueMessage(message(scene), {
        ownerUserId: 'owner-1',
        threadId: 'thread-1',
      }),
      [
        {
          scene,
          source: {
            kind: 'message',
            threadId: 'thread-1',
            sourceMessageId: 'message-meeting-1',
            authorUserId: 'owner-1',
            authorRole: 'owner',
            visibility: 'verified_live_owner_message',
          },
        },
      ],
    );
  });

  it('fails closed on owner/thread/author/provenance changes and deletion', async () => {
    const scene = await sceneAt(Date.now());
    const scope = { ownerUserId: 'owner-1', threadId: 'thread-1' };
    const rejected = [
      message(scene, { userId: 'owner-2' }),
      message(scene, { threadId: 'thread-2' }),
      message(scene, { catId: 'codex' }),
      message(scene, { deletedAt: Date.now() }),
      message(scene, { _tombstone: true }),
      message(scene, { extra: { dynamicSceneEntries: [scene] } }),
      message(scene, {
        extra: {
          meetingArtifact: {
            intakeId: 'meeting-1',
            sourceHandle: 'meeting://source-1',
            trust: 'untrusted_external',
            instructionPolicy: 'instructions_allowed',
          },
          dynamicSceneEntries: [scene],
        },
      }),
    ];
    for (const candidate of rejected) {
      assert.deepEqual(bindAsrPersonMemoryScenesFromQueueMessage(candidate, scope), []);
    }
  });
});
