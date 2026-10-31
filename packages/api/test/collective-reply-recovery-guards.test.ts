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
const guardCases: ReadonlyArray<{
  name: string;
  mutate: (value: ReturnType<typeof recoveryFixture>) => void;
}> = [
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
    it(`rejects ${guardCase.name} before queue effects`, async () => {
      const harness = await openRecoveryHarness({ mutate: guardCase.mutate });
      try {
        const result = await harness.post();
        assert.ok([404, 409].includes(result.statusCode), result.body);
        assert.equal(harness.queue.list(THREAD, OWNER).length, 0);
      } finally {
        await harness.app.close();
      }
    });
  }

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
