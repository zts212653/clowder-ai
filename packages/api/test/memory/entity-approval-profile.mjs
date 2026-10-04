// Bounded synthetic comparison; never opens the runtime evidence database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { InMemoryEntityProposalStore } from '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js';
import { EntityRegistryStore } from '../../dist/domains/memory/EntityRegistry.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { registerEntityProposalDecisionRoutes } from '../../dist/routes/entity-proposal-decision-routes.js';
import { anchorApproval } from '../approval-hub/helpers.js';

const entityCount = 200;
const passageCount = 25000;
const date = '2026-09-17T00:00:00.000Z';
const originalRefresh = EntityRegistryStore.prototype.refreshMentionsForEntities;
const entity = (id, alias) => ({
  entityId: `concept:${id}`,
  type: 'concept',
  canonicalName: id,
  aliases: [alias],
  provenance: [{ source: 'synthetic' }],
  updatedAt: date,
});

async function run(mode) {
  const app = Fastify();
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  try {
    await store.upsertEntities(
      Array.from({ length: entityCount }, (_, i) => entity(`entity${i}`, `词条${String(i).padStart(4, '0')}`)),
    );
    await store.upsert([
      {
        anchor: 'doc:synthetic',
        kind: 'feature',
        status: 'active',
        title: 'Synthetic corpus',
        summary: '新增术语',
        updatedAt: date,
      },
    ]);
    const db = store.getDb();
    const insert = db.prepare(`INSERT INTO evidence_passages
      (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (let i = 0; i < passageCount; i++) {
        insert.run(
          'doc:synthetic',
          `msg:${i}`,
          `词条${String(i % entityCount).padStart(4, '0')} ${i % 10 === 0 ? '新增术语' : ''} ${'这是合成的上下文，用于衡量提及匹配而非真实消息。'.repeat(8)}`,
          'synthetic',
          i,
          date,
        );
      }
    })();
    await store.refreshEntityMentions();
    db.exec(`CREATE TEMP TABLE deleted_mentions(entity_id TEXT);
      CREATE TEMP TRIGGER observe_deletes AFTER DELETE ON entity_mentions_legacy BEGIN
        INSERT INTO deleted_mentions VALUES (OLD.entity_id);
      END;`);
    // Reproduce the pre-fix global refresh without changing the mutation or corpus.
    EntityRegistryStore.prototype.refreshMentionsForEntities =
      mode === 'global-baseline'
        ? function () {
            this.refreshMentions();
          }
        : originalRefresh;
    const proposals = new InMemoryEntityProposalStore();
    const proposal = proposals.create({
      entityId: 'concept:incoming',
      entityType: 'concept',
      canonicalName: 'incoming',
      aliases: ['新增术语'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'synthetic' }],
      rationale: 'Synthetic approval benchmark',
      sourceThreadId: 'synthetic-thread',
      sourceCatId: 'codex-astra',
      ownerUserId: 'synthetic',
    });
    await anchorApproval(proposals, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F260',
      ownerUserId: 'synthetic',
      requesterCatId: 'codex-astra',
      threadId: 'synthetic-thread',
      createdAt: proposal.createdAt,
    });
    const emitted = [];
    registerEntityProposalDecisionRoutes(app, {
      store: proposals,
      upsertEntities: store.upsertEntities.bind(store),
      inspectEntityConflict: store.inspectEntityConflict.bind(store),
      resolveEntityConflict: store.resolveEntityConflict.bind(store),
      socketManager: { emitToUser: (...args) => emitted.push(args) },
    });
    await app.ready();
    const start = performance.now();
    const heartbeat = new Promise((resolve) => setTimeout(() => resolve(performance.now() - start), 0));
    const response = await app.inject({
      method: 'POST',
      url: `/api/entity-proposals/${proposal.proposalId}/approve`,
      headers: { 'x-cat-cafe-user': 'synthetic' },
    });
    const elapsedMs = performance.now() - start;
    const timerDelayMs = await heartbeat;
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(proposals.get(proposal.proposalId).status, 'approved');
    assert.equal(emitted.length, 1);
    assert.equal((await store.resolveEntityAliases('新增术语'))[0].entityId, 'concept:incoming');
    const rows = db
      .prepare(`SELECT entity_id, doc_anchor, passage_id, surface, surface_norm, source,
      created_at FROM entity_mentions ORDER BY entity_id, doc_anchor, passage_id, surface_norm`)
      .all();
    const unrelatedDeletes = db.prepare('SELECT COUNT(*) AS n FROM deleted_mentions').get().n;
    const incomingMentions = rows.filter((row) => row.entity_id === 'concept:incoming').length;
    assert.equal(incomingMentions, 2501);
    assert.equal(rows.length, passageCount + incomingMentions);
    assert.equal(unrelatedDeletes, mode === 'global-baseline' ? passageCount : 0);
    return {
      mode,
      elapsedMs,
      timerDelayMs,
      unrelatedDeletes,
      incomingMentions,
      totalMentions: rows.length,
      mentionDigest: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  } finally {
    EntityRegistryStore.prototype.refreshMentionsForEntities = originalRefresh;
    await app.close();
    store.close();
  }
}

const runs = [];
for (let round = 0; round < 3; round++) {
  const modes = round % 2 ? ['scoped-fixed', 'global-baseline'] : ['global-baseline', 'scoped-fixed'];
  for (const mode of modes) runs.push({ round, ...(await run(mode)) });
}
assert.equal(
  new Set(runs.map((run) => run.mentionDigest)).size,
  1,
  'both modes must produce identical complete mention rows',
);
const report = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  entityCount,
  passageCount,
  runs,
  limits:
    'Native approve handler via Fastify injection and in-memory proposal/SQLite stores; one document and 25000 passages, 200 existing entities, three alternating pairs. Measures only approval request, excludes fixture creation. Baseline restores the former full refresh. Digest excludes per-proposal provenance (unique proposal IDs). Not production timing or proof of all timeout causes.',
};
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
