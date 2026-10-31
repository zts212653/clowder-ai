import assert from 'node:assert/strict';
import { test } from 'node:test';

const { collectRecentGlobalWorkCandidates } = await import(
  '../dist/domains/cats/services/agents/routing/recent-global-work-reader.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

test('artifact ceiling bounds a huge gallery and makes an exhausted message scan honestly incomplete', async () => {
  const store = new MessageStore();
  store.append({
    userId: 'owner',
    threadId: 'thread-gallery',
    from: { kind: 'agent', catId: 'codex-sol' },
    content: 'large gallery',
    mentions: [],
    timestamp: Date.now(),
    extra: {
      rich: {
        v: 1,
        blocks: [
          {
            kind: 'media_gallery',
            v: 1,
            id: 'large-gallery',
            items: Array.from({ length: 20 }, (_, index) => ({
              url: `/uploads/gallery-${index}.png`,
              caption: `gallery-${index}.png`,
            })),
          },
        ],
      },
    },
  });

  const result = await collectRecentGlobalWorkCandidates({
    store,
    userId: 'owner',
    threadTitles: new Map([['thread-gallery', 'Gallery']]),
    limit: 3,
    artifactLimit: 8,
  });

  assert.equal(result.scannedMessages, 1);
  assert.equal(result.artifacts.length, 8);
  assert.equal(result.complete, false);
});

test('a lost cursor fails closed and retains only the proven newer timestamp prefix', async () => {
  const fileMessage = (id, timestamp, fileName) => ({
    id,
    userId: 'owner',
    threadId: 'thread-cursor',
    catId: 'codex-sol',
    content: fileName,
    mentions: [],
    timestamp,
    extra: {
      rich: {
        v: 1,
        blocks: [{ kind: 'file', v: 1, id: fileName, url: `/uploads/${fileName}`, fileName }],
      },
    },
  });
  const time = Date.now();
  const tied = fileMessage('tie-cursor', time, 'unsafe-tie.pdf');
  const newer = fileMessage('newer', time + 10, 'proven-newer.pdf');
  let calls = 0;

  const result = await collectRecentGlobalWorkCandidates({
    store: {
      getOwnerBeforeBounded: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            messages: [tied, newer],
            scannedCount: 2,
            storageRoundTrips: 0,
            exhausted: false,
            oldestTimelineGroupComplete: false,
            nextCursor: { timestamp: time, id: tied.id },
          };
        }
        return {
          messages: [],
          scannedCount: 0,
          storageRoundTrips: 0,
          exhausted: false,
          oldestTimelineGroupComplete: false,
        };
      },
    },
    userId: 'owner',
    threadTitles: new Map([['thread-cursor', 'Cursor']]),
    limit: 3,
    pageSize: 2,
  });

  assert.equal(result.complete, false);
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.name),
    ['proven-newer.pdf'],
  );
});
