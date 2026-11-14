import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KnowledgeResolver } from '../../dist/domains/memory/KnowledgeResolver.js';
import { documentDiscoverySource } from '../../dist/domains/memory/knowledge-document-source.js';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MatterMemoryService } from '../../dist/domains/memory/matters/MatterMemoryService.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

async function fixture() {
  const db = new SqliteEvidenceStore(':memory:');
  await db.initialize();
  await db.upsert([
    {
      anchor: 'F332',
      kind: 'feature',
      status: 'active',
      title: 'needle document',
      sourceHash: 'a'.repeat(64),
      sourcePath: 'features/F332.md',
      sourceIds: ['thread-t#message-m'],
      updatedAt: '2026-11-07',
    },
  ]);
  const message = {
    id: 'm',
    threadId: 't',
    userId: 'owner',
    catId: null,
    content: 'needle canonical message.',
    timestamp: 1,
  };
  const messages = new Map([['m', message]]);
  const thread = { id: 't', title: 'Original', createdBy: 'owner' };
  const threadStore = { get: () => thread, list: () => [thread] };
  const messageStore = { getById: (id) => messages.get(id) ?? null };
  const actor = { userId: 'owner', viewer: { type: 'cat', catId: 'codex-astra' } };
  const matters = new MatterMemoryService({
    db: db.getDb(),
    runWrite: (op) => db.runExclusive(op),
    threadStore,
    messageStore,
  });
  const receipt = await matters.write(actor, {
    operation: 'create',
    requestId: 'create',
    title: 'needle matter',
    description: 'Historical scope only',
    sources: [
      { threadId: 't', messageId: 'm', segment: 'body', start: 0, end: message.content.length, quote: message.content },
    ],
  });
  let retrieval;
  const service = new MessageSearchService({
    threadStore,
    messageStore,
    evidenceStore: {
      readMessagePassageState: () => ({ current: true, suppressThreadTitle: false }),
      searchMessagePassages: async (_query, options) => {
        retrieval = options;
        return {
          passages: [
            {
              docAnchor: 'thread-t',
              passageId: 'msg-m',
              threadId: 't',
              messageId: 'm',
              content: message.content,
              match: 'lexical',
            },
            {
              docAnchor: 'thread-foreign',
              passageId: 'msg-secret',
              threadId: 'foreign',
              messageId: 'secret',
              content: 'SECRET',
              match: 'lexical',
            },
          ],
          meta: { degraded: false, effectiveMode: 'hybrid', sort: 'relevance', truncated: false },
        };
      },
    },
  });
  return {
    db,
    message,
    messages,
    actor,
    matters,
    service,
    matterId: receipt.matter.matterId,
    retrieval: () => retrieval,
  };
}

test('one discovery call admits native document, chat and Matter candidates with their original coordinates', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const deadlineAt = Date.now() + 5000;
  try {
    const found = await KnowledgeResolver.discover('needle', {
      limit: 10,
      signal: controller.signal,
      deadlineAt,
      sources: [
        documentDiscoverySource({ id: 'docs', store: f.db, options: { scope: 'docs', mode: 'lexical' } }),
        f.service.discoverySource({ query: 'needle' }, f.actor),
        f.matters.discoverySource(f.actor),
      ],
    });
    assert.deepEqual(
      found.sources.map((source) => [source.sourceId, source.items.length]),
      [
        ['docs', 1],
        ['messages', 1],
        ['matters', 1],
      ],
    );
    assert.equal(found.sources[0].items[0].sourceHash, 'a'.repeat(64));
    assert.equal(found.sources[1].items[0].messageId, 'm');
    assert.ok(found.sources[1].items[0].contentRevision);
    assert.equal(found.sources[2].items[0].item.matterId, f.matterId);
    assert.equal(JSON.stringify(found).includes('SECRET'), false);
    assert.notEqual(f.retrieval().signal, controller.signal);
    assert.equal(f.retrieval().signal.aborted, true, 'the completed discovery closes only its owned scope');
    assert.equal(controller.signal.aborted, false);
    assert.equal(f.retrieval().deadlineAt, deadlineAt);
    assert.equal(f.db.getDb().prepare('SELECT count(*) AS n FROM memory_cue_events').get().n, 0);
  } finally {
    await f.db.close();
  }
});

test('a later source cannot leave a recalled chat candidate in the mixed result', async () => {
  const f = await fixture();
  try {
    let projected;
    const ready = new Promise((resolve) => {
      projected = resolve;
    });
    const messageSource = f.service.discoverySource({ query: 'needle' }, f.actor);
    const projectWave = messageSource.projectWave;
    messageSource.projectWave = async (rows) => {
      const result = await projectWave(rows);
      projected();
      return result;
    };
    const found = await KnowledgeResolver.discover('needle', {
      limit: 10,
      sources: [
        messageSource,
        {
          id: 'later-source',
          read: async () => {
            await ready;
            f.messages.delete('m');
            return { candidates: [] };
          },
          project: async () => null,
          key: (item) => String(item),
        },
      ],
    });
    assert.deepEqual(found.items, []);
    assert.deepEqual(found.sources[0].items, []);
  } finally {
    await f.db.close();
  }
});
