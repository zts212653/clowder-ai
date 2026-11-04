import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import {
  BODY,
  CAT,
  OWNER,
  openRecoveryHarness,
  outputLayout,
  RESPONSE_ID,
  recoveryFixture,
  replaceFinalBody,
  THREAD,
} from './helpers/collective-reply-recovery-fixture.js';

const recall = { version: 1, exposure: 'none', recalledAt: 4 } as const;

function useTopLevelPresentation(source: StoredMessage, from: NonNullable<StoredMessage['from']>): void {
  const presentation = source.extra?.pluginMessage?.presentation;
  assert.ok(presentation);
  source.from = from;
  source.source = presentation;
  source.extra = undefined;
}

const guardCases: ReadonlyArray<{
  name: string;
  mutate: (value: ReturnType<typeof recoveryFixture>) => void;
}> = [
  {
    name: 'a plugin source whose strict payload instance disagrees with its sender',
    mutate: ({ source }) => {
      const pluginMessage = source.extra?.pluginMessage;
      assert.ok(pluginMessage);
      Object.assign(pluginMessage, { instanceId: 'pi_other' });
    },
  },
  {
    name: 'a plugin source whose canonical sender instance disagrees with its payload',
    mutate: ({ source }) => {
      source.from = { kind: 'plugin', instanceId: 'pi_other' };
    },
  },
  {
    name: 'a plugin source whose canonical provenance names another instance',
    mutate: ({ source }) => {
      const pluginMessage = source.extra?.pluginMessage;
      assert.ok(pluginMessage);
      pluginMessage.provenance = {
        origin: { kind: 'plugin', instanceId: 'pi_other' },
        epistemicStatus: 'observation',
      };
    },
  },
  {
    name: 'a plugin source whose canonical provenance is not plugin-owned',
    mutate: ({ source }) => {
      const pluginMessage = source.extra?.pluginMessage;
      assert.ok(pluginMessage);
      pluginMessage.provenance = {
        origin: { kind: 'host' },
        epistemicStatus: 'observation',
      };
    },
  },
  {
    name: 'a plugin source whose presentation names another connector',
    mutate: ({ source }) => {
      const presentation = source.extra?.pluginMessage?.presentation;
      assert.ok(presentation);
      presentation.connector = 'other';
    },
  },
  {
    name: 'a user-authored source carrying top-level Collective presentation',
    mutate: ({ source }) => useTopLevelPresentation(source, { kind: 'user', userId: OWNER }),
  },
  {
    name: 'an agent-authored source carrying top-level Collective presentation',
    mutate: ({ source }) => useTopLevelPresentation(source, { kind: 'agent', catId: CAT }),
  },
  {
    name: 'a system-authored source carrying top-level Collective presentation',
    mutate: ({ source }) => useTopLevelPresentation(source, { kind: 'system', service: 'test' }),
  },
  {
    name: 'an external source from another connector',
    mutate: ({ source }) => useTopLevelPresentation(source, { kind: 'external', connectorId: 'other' }),
  },
  {
    name: 'a source attributed to an agent instead of the owner input',
    mutate: ({ source }) => {
      source.catId = CAT;
    },
  },
  {
    name: 'a plugin source with a malformed strict payload',
    mutate: ({ source }) => {
      const pluginMessage = source.extra?.pluginMessage;
      assert.ok(pluginMessage);
      Object.assign(pluginMessage, { revision: 0 });
    },
  },
  { name: 'a soft-deleted source', mutate: ({ source }) => Object.assign(source, { deletedAt: 4 }) },
  { name: 'a recalled source', mutate: ({ source }) => Object.assign(source, { recall }) },
  { name: 'a canceled source', mutate: ({ source }) => Object.assign(source, { deliveryStatus: 'canceled' }) },
  { name: 'a tombstoned source', mutate: ({ source }) => Object.assign(source, { _tombstone: true }) },
  { name: 'a soft-deleted response', mutate: ({ response }) => Object.assign(response, { deletedAt: 4 }) },
  { name: 'a recalled response', mutate: ({ response }) => Object.assign(response, { recall }) },
  { name: 'a canceled response', mutate: ({ response }) => Object.assign(response, { deliveryStatus: 'canceled' }) },
  { name: 'a tombstoned response', mutate: ({ response }) => Object.assign(response, { _tombstone: true }) },
  { name: 'a response from another thread', mutate: ({ response }) => Object.assign(response, { threadId: 'other' }) },
  { name: 'a response owned by another user', mutate: ({ response }) => Object.assign(response, { userId: 'other' }) },
  {
    name: 'a response replying to another source',
    mutate: ({ response }) => Object.assign(response, { replyTo: 'other' }),
  },
  {
    name: 'a response with another input source',
    mutate: ({ response }) => {
      response.lifecycle = { ...response.lifecycle, inputMessageIds: ['other'] } as StoredMessage['lifecycle'];
    },
  },
  {
    name: 'an unsettled dispatch',
    mutate: ({ source }) => {
      assert.equal(source.lifecycle?.kind, 'input');
      source.lifecycle = {
        ...source.lifecycle,
        dispatchRefs: [{ targetId: CAT, phase: 'dispatched', statusMessageId: RESPONSE_ID, dispatchedAt: 2 }],
      };
    },
  },
  {
    name: 'a rich response',
    mutate: ({ response }) => Object.assign(response, { contentBlocks: [{ type: 'text', text: BODY }] }),
  },
  {
    name: 'a layout owned by another thread',
    mutate: ({ response }) => Object.assign(outputLayout(response).owner, { threadId: 'other' }),
  },
  {
    name: 'a layout owned by another cat',
    mutate: ({ response }) => Object.assign(outputLayout(response).owner, { catId: 'opus' }),
  },
  {
    name: 'a layout owned by another invocation',
    mutate: ({ response }) => Object.assign(outputLayout(response).owner, { turnInvocationId: 'other' }),
  },
  {
    name: 'an equal-length body change',
    mutate: ({ response }) => {
      response.content = `喵${response.content.slice(1)}`;
    },
  },
  {
    name: 'multiple model final ranges',
    mutate: ({ response }) => {
      const layout = outputLayout(response);
      const first = layout.runs[0];
      assert.ok(first);
      Object.assign(layout, {
        runs: [
          { ...first, id: 'run-a', start: 0, end: 1 },
          { ...first, id: 'run-b', start: 1, end: BODY.length },
        ],
        order: [
          { kind: 'run', runId: 'run-a' },
          { kind: 'run', runId: 'run-b' },
        ],
      });
    },
  },
  {
    name: 'a reply over the Collective length limit',
    mutate: ({ response }) => replaceFinalBody(response, 'x'.repeat(20_001)),
  },
];

describe('Collective reply recovery trust boundary', () => {
  for (const guardCase of guardCases) {
    it(`rejects ${guardCase.name} from both readback and write admission`, async () => {
      const harness = await openRecoveryHarness({ mutate: guardCase.mutate });
      try {
        const probe = await harness.probe();
        assert.ok([404, 409].includes(probe.statusCode), probe.body);
        const post = await harness.post();
        assert.ok([404, 409].includes(post.statusCode), post.body);
        assert.equal(harness.queue.list(THREAD, OWNER).length, 0);
        assert.equal(harness.requestDrain.mock.callCount(), 0);
      } finally {
        await harness.app.close();
      }
    });
  }

  it('returns not found to another owner without exposing recoverability', async () => {
    const harness = await openRecoveryHarness();
    try {
      const result = await harness.probe({ owner: 'other' });
      assert.equal(result.statusCode, 404, result.body);
      assert.equal(harness.queue.list(THREAD, OWNER).length, 0);
      assert.equal(harness.requestDrain.mock.callCount(), 0);
    } finally {
      await harness.app.close();
    }
  });

  it('rejects an unavailable target before queue effects', async () => {
    const harness = await openRecoveryHarness({ catAvailable: false });
    try {
      const result = await harness.post();
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(harness.queue.list(THREAD, OWNER).length, 0);
    } finally {
      await harness.app.close();
    }
  });
});
