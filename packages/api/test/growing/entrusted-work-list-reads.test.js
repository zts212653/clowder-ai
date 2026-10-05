import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../helpers/setup-cat-registry.js';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { EntrustedWorkLifecycleService } = await import('../../dist/domains/growing/EntrustedWorkLifecycleService.js');
const { EntrustedWorkOwnerReadService } = await import('../../dist/domains/growing/EntrustedWorkOwnerReadService.js');
const { F232PreparedArtifactReader } = await import('../../dist/domains/growing/F232PreparedArtifactReader.js');
const { ReviewedMediaArtifactReader } = await import('../../dist/domains/growing/ReviewedMediaArtifactReader.js');

async function fixture(completed) {
  const threadId = 'thread-many-deliveries';
  const artifactRef = '/uploads/original-result.md';
  let scans = 0;
  let inFlight = 0;
  let peakReads = 0;
  async function observeRead() {
    scans++;
    peakReads = Math.max(peakReads, ++inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight--;
  }
  let messages = Array.from({ length: 1001 }, (_, i) => ({
    id: `message-${i}`,
    userId: 'owner',
    threadId,
    catId: 'codex-sol',
    timestamp: i + 1,
    content: 'Conversation',
    ...(i === 0
      ? { extra: { rich: { blocks: [{ kind: 'file', v: 1, id: 'result', fileName: 'Result.md', url: artifactRef }] } } }
      : {}),
  }));
  const reader = new F232PreparedArtifactReader({
    messages: {
      async getByThread(id, limit, userId) {
        await observeRead();
        return messages.filter((m) => m.threadId === id && m.userId === userId).slice(-limit);
      },
      async getByThreadBefore(id, before, limit, _beforeId, userId) {
        await observeRead();
        return messages.filter((m) => m.threadId === id && m.userId === userId && m.timestamp < before).slice(-limit);
      },
    },
  });
  const tasks = new TaskStore();
  const lifecycle = new EntrustedWorkLifecycleService(tasks, { artifactReader: reader });
  for (let i = 0; i < 20; i++) {
    const result = await lifecycle.admitOrResume({
      task: {
        threadId,
        userId: 'owner',
        ownerCatId: 'codex-sol',
        createdBy: 'codex-sol',
        title: `Work ${i}`,
        why: 'Source',
      },
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:source-${i}`],
        intendedOutcome: `Deliver ${i}`,
        idempotencyKey: `work-${i}`,
      },
      artifactRefs: [artifactRef],
      closure: { condition: 'Accepted result', expectedSignal: 'message:accepted' },
    });
    if (completed) {
      await lifecycle.close({
        taskId: result.ownerRef.slice('task:item:'.length),
        expectedRevision: 1,
        closure: {
          state: 'satisfied',
          condition: 'Accepted result',
          expectedSignal: 'message:accepted',
          evidenceRefs: ['message:accepted'],
        },
      });
    }
  }
  scans = 0;
  peakReads = 0;
  return {
    service: new EntrustedWorkOwnerReadService({
      tasks,
      artifactReader: new ReviewedMediaArtifactReader({
        publications: reader,
        store: { listForTask: () => [] },
        reviews: {},
      }),
      producerCatalog: {
        async listCurrentReceipts() {
          return [];
        },
      },
    }),
    scanCount: () => scans,
    peakReads: () => peakReads,
    revoke() {
      messages = messages.map((m) => (m.id === 'message-0' ? { ...m, recall: true } : m));
    },
  };
}

for (const view of ['active', 'completed']) {
  test(`${view} work shares one complete thread scan per list and refreshes revoked publications`, async () => {
    const f = await fixture(view === 'completed');
    const before = await f.service.listForOwner('owner', view);
    assert.equal(before.length, 20, 'history must not be silently truncated');
    assert.ok(before.every((row) => row.preparedArtifact?.artifactRevision === '1'));
    assert.equal(f.scanCount(), 6, 'twenty works over 1,001 messages should read six pages, not 120');
    assert.equal(f.peakReads(), 1, 'lists must not fan out unbounded concurrent thread scans');
    f.revoke();
    const after = await f.service.listForOwner('owner', view);
    assert.equal(f.scanCount(), 12, 'the next request must reread owner publications');
    assert.deepEqual(
      after.map((row) => row.envelope),
      before.map((row) => row.envelope),
    );
    assert.ok(after.every((row) => row.preparedArtifact === undefined));
    assert.deepEqual(await f.service.listForOwner('foreign', view), []);
    assert.equal(f.scanCount(), 12, 'foreign work must be rejected before reading any messages');
  });
}
