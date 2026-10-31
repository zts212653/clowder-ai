import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitRecallOpportunity } from '../../src/domains/memory/cue/RecallOpportunityCatalog.js';

test('catalog admits only the server-bound first owner-message thread overview opportunity', () => {
  const scope = { ownerUserId: 'owner', threadId: 'new', invocationId: 'inv' };
  const candidate = {
    v: 1,
    opportunityId: 'op',
    consumer: 'agent_route',
    scope,
    occurredAt: 1,
    kind: 'thread_opened',
    producer: 'owner_message',
    payload: { sourceMessageId: 'first' },
  };
  assert.ok(admitRecallOpportunity(candidate, scope));
  assert.equal(admitRecallOpportunity({ ...candidate, scope: { ...scope, ownerUserId: 'other' } }, scope), null);
  assert.equal(admitRecallOpportunity({ ...candidate, kind: 'free_text_intent' }, scope), null);
});

import { RECALL_RESOLVER_FAMILIES } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryCueEpisodeStore } from '../../src/domains/memory/cue/MemoryCueEpisodeStore.js';
import { MemoryCuePlaneService } from '../../src/domains/memory/cue/MemoryCuePlaneService.js';
import { MemoryCueResolverRegistry } from '../../src/domains/memory/cue/MemoryCueResolverRegistry.js';
import { ThreadOverviewMemoryCueSource } from '../../src/domains/memory/cue/sources/ThreadOverviewMemoryCueSource.js';
import { overviewRevision } from '../../src/domains/memory/curation/LunaCurationState.js';
import { LunaThreadLibrarian } from '../../src/domains/memory/curation/LunaThreadLibrarian.js';
import { ThreadOverviewRepository } from '../../src/domains/memory/curation/ThreadOverviewRepository.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { writeEvidenceItems } from '../../src/domains/memory/write-evidence-items.js';

function fixture() {
  const db = new Database(':memory:');
  applyMigrations(db);
  const threads = new ThreadStore();
  const messages = new MessageStore();
  const old = threads.create('owner', '画面身份连续性');
  const source = messages.append({
    threadId: old.id,
    userId: 'owner',
    catId: null,
    timestamp: Date.now(),
    content: '头顶只有两块灰斑，按母图重画。',
  });
  const summary = `创作时纠正了角色身份，要沿母图画头顶。 （来源：${old.id}#${source.id}）`;
  db.prepare(
    "INSERT INTO evidence_docs(anchor,kind,status,title,summary,updated_at) VALUES (?,'thread','active',?,?,?)",
  ).run(`thread-${old.id}`, old.title, summary, new Date().toISOString());
  const fresh = threads.create('owner', '新想法');
  const opening = messages.append({
    threadId: fresh.id,
    userId: 'owner',
    catId: null,
    timestamp: Date.now(),
    content: '我们做个3D宪宪喵建模',
  });
  const repository = new ThreadOverviewRepository({
    db,
    ownerUserId: 'owner',
    threadStore: threads,
    messageStore: messages,
  });
  return { db, threads, messages, old, source, fresh, opening, repository };
}

test('ordinary index refresh preserves the committed current overview and directory revision', () => {
  const f = fixture();
  try {
    const before = f.db.prepare('SELECT summary FROM evidence_docs WHERE anchor=?').get(`thread-${f.old.id}`).summary;
    const revision = overviewRevision(before);
    f.db.prepare('UPDATE evidence_docs SET source_hash=? WHERE anchor=?').run(revision, `thread-${f.old.id}`);
    f.db
      .prepare(`INSERT INTO thread_curation_state(owner_user_id,thread_id,provider_identity,summary_revision,directory_line)
      VALUES ('owner',?,'account',?,'角色形象经历')`)
      .run(f.old.id, revision);
    writeEvidenceItems(f.db, [
      {
        anchor: `thread-${f.old.id}`,
        kind: 'thread',
        status: 'active',
        title: '更新标题',
        summary: '刚收到的一条消息',
        sourceHash: 'scanner',
        updatedAt: new Date().toISOString(),
      },
    ]);
    const after = f.db
      .prepare('SELECT summary,source_hash FROM evidence_docs WHERE anchor=?')
      .get(`thread-${f.old.id}`);
    assert.equal(after.summary, before);
    assert.equal(after.source_hash, revision);
  } finally {
    f.db.close();
  }
});

test('whole directory preserves old tail and gaps; clean model calls select without shared words and reach actual cue/drill ledger', async () => {
  const f = fixture();
  const prompts: string[] = [];
  try {
    for (let n = 0; n < 70; n++) f.threads.create('owner', `历史条目${n}`);
    const other = f.threads.create('another-owner', 'PRIVATE_SECRET');
    const directory = await f.repository.directory('owner', 'codex61-sol', f.fresh.id);
    assert.equal(directory.entries.length, 71);
    assert.equal(directory.coverage.missing, 70);
    assert.ok(directory.entries.some((entry) => entry.threadId === f.old.id));
    assert.ok(!directory.entries.some((entry) => entry.threadId === other.id));
    const librarian = new LunaThreadLibrarian({
      repository: f.repository,
      workingDirectory: '/tmp',
      resolveProvider: () => ({
        catId: 'codex6-luna',
        model: 'gpt-6-luna',
        options: { sessionId: 'MUST_NOT_RESUME' },
        service: {
          async *invoke(prompt, options) {
            assert.equal(options?.sessionId, undefined);
            prompts.push(prompt);
            yield {
              type: 'text',
              catId: 'codex6-luna',
              timestamp: 0,
              content:
                JSON.stringify(
                  prompt.includes('哪些旧线程')
                    ? { related: [{ threadId: f.old.id, reason: '立体形象仍需守住角色身份' }] }
                    : {
                        backgrounds: [
                          { threadId: f.old.id, background: '头顶形象须沿母图核对。', sourceIds: [f.source.id] },
                        ],
                      },
                ) + '\n\n[GPT-6 Luna/gpt-6-luna🐾]',
            };
            yield { type: 'done', catId: 'codex6-luna', timestamp: 1 };
          },
        },
      }),
    });
    const source = new ThreadOverviewMemoryCueSource({
      repository: f.repository,
      librarian,
      messageStore: f.messages,
      enabled: () => true,
    });
    const seed = await source.prepareOpportunity({
      ownerUserId: 'owner',
      threadId: f.fresh.id,
      sourceMessageId: f.opening.id,
      occurredAt: 100,
    });
    assert.ok(seed);
    const registry = new MemoryCueResolverRegistry(
      RECALL_RESOLVER_FAMILIES.map((family) =>
        family === 'thread_overview' ? source : { family, resolverVersion: 1, resolve: async () => [] },
      ),
    );
    const ledger = new MemoryCueEpisodeStore(f.db);
    const plane = new MemoryCuePlaneService(registry, ledger);
    const scope = { ownerUserId: 'owner', threadId: f.fresh.id, invocationId: 'inv' };
    const resolution = await plane.resolve({
      candidate: { v: 1, opportunityId: 'op', consumer: 'agent_route', scope, ...seed },
      serverScope: scope,
      now: 101,
      consumerCatId: 'codex61-sol',
      invocationState: { seenDedupeKeys: new Set() },
      createDrillHandle: () => 'handle',
    });
    assert.equal(resolution.cues.length, 1);
    assert.match(resolution.presentationEnvelopes[0].segments.clue!, /立体形象仍需守住角色身份/);
    assert.match(resolution.presentationEnvelopes[0].segments.clue!, /母图/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_cue_events').get().n, 0);
    await plane.recordPresented(resolution.deliveryReceipts, {
      generationId: 'real-delivery',
      evidenceRef: 'provider-confirmation',
    });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_cue_events').get().n, 1);
    const cue = resolution.cues[0];
    assert.ok(resolution.presentationEnvelopes[0].segments.clue!.includes(cue.cueId));
    const drill = await source.read({
      ownerUserId: 'owner',
      consumerCatId: 'codex61-sol',
      anchor: cue.source.anchor,
      expectedRevision: cue.source.revision,
    });
    assert.equal(drill.status, 'ok');
    assert.match(JSON.stringify(drill), new RegExp(f.source.id));
    assert.ok(prompts[0].includes('历史条目69'));
    assert.ok(!prompts[0].includes('PRIVATE_SECRET'));
    const second = f.messages.append({
      threadId: f.fresh.id,
      userId: 'owner',
      catId: null,
      timestamp: Date.now(),
      content: '第二轮',
    });
    assert.equal(
      await source.prepareOpportunity({
        ownerUserId: 'owner',
        threadId: f.fresh.id,
        sourceMessageId: second.id,
        occurredAt: 200,
      }),
      null,
    );
    assert.equal(
      await source.prepareOpportunity({
        ownerUserId: 'another-owner',
        threadId: f.fresh.id,
        sourceMessageId: f.opening.id,
        occurredAt: 200,
      }),
      null,
    );
    f.source.visibility = 'whisper';
    f.source.whisperTo = ['codex61-sol'];
    assert.equal(
      (
        await source.read({
          ownerUserId: 'owner',
          consumerCatId: 'codex61-sol',
          anchor: cue.source.anchor,
          expectedRevision: cue.source.revision,
        })
      ).status,
      'not_available',
    );
  } finally {
    f.db.close();
  }
});

test('unrelated zero selection and an uncooperative model timeout never block owner chat', async () => {
  const f = fixture();
  try {
    const make = (slow: boolean) =>
      new LunaThreadLibrarian({
        repository: f.repository,
        workingDirectory: '/tmp',
        timeoutMs: 20,
        resolveProvider: () => ({
          catId: 'codex6-luna',
          model: 'gpt-6-luna',
          service: {
            async *invoke() {
              if (slow) await new Promise(() => {});
              yield { type: 'text', catId: 'codex6-luna', timestamp: 0, content: '{"related":[]}' };
              yield { type: 'done', catId: 'codex6-luna', timestamp: 1 };
            },
          },
        }),
      });
    const input = { ownerUserId: 'owner', consumerCatId: 'codex61-sol', threadId: f.fresh.id, opening: '无关请求' };
    assert.deepEqual(await make(false).recall(input), []);
    const start = Date.now();
    assert.deepEqual(await make(true).recall(input), []);
    assert.ok(Date.now() - start < 300);
  } finally {
    f.db.close();
  }
});

test('the readable shared lobby is discoverable while missing index rows still drill actual public originals', async () => {
  const f = fixture();
  try {
    const lobby = f.threads.get('default');
    assert.ok(lobby);
    const publicMessage = f.messages.append({
      threadId: lobby.id,
      userId: 'owner',
      catId: null,
      content: 'Earlier shared idea',
      timestamp: 1,
    });
    f.messages.append({
      threadId: lobby.id,
      userId: 'other-owner',
      catId: null,
      content: 'FOREIGN_OWNER_BODY',
      timestamp: 2,
    });
    const directory = await f.repository.directory('owner', 'codex61-sol');
    assert.ok(directory.entries.some((e) => e.threadId === lobby.id));
    const overview = await f.repository.read('owner', 'codex61-sol', lobby.id);
    assert.ok(overview);
    assert.match(overview.summary, new RegExp(publicMessage.id));
    assert.ok(!overview.summary.includes('FOREIGN_OWNER_BODY'));
    f.db.prepare('DELETE FROM evidence_docs WHERE anchor=?').run(`thread-${f.old.id}`);
    assert.ok(
      await f.repository.read('owner', 'codex61-sol', f.old.id),
      'missing document is a coverage gap, not an unreadable source',
    );
  } finally {
    f.db.close();
  }
});

test('a legacy summary cannot impersonate a generated overview by appending one readable source coordinate', async () => {
  const f = fixture();
  try {
    f.db
      .prepare('UPDATE evidence_docs SET summary=? WHERE anchor=?')
      .run(`UNATTRIBUTED_PRIVATE_BODY （来源：${f.old.id}#${f.source.id}）`, `thread-${f.old.id}`);
    const read = await f.repository.read('owner', 'codex61-sol', f.old.id);
    assert.ok(read);
    assert.ok(!read.summary.includes('UNATTRIBUTED_PRIVATE_BODY'));
    assert.equal(read.legacy, true);
  } finally {
    f.db.close();
  }
});
