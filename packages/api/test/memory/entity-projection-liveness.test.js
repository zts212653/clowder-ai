import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import Fastify from 'fastify';
import { InMemoryEntityProposalStore } from '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';
import { registerEntityProposalDecisionRoutes } from '../../dist/routes/entity-proposal-decision-routes.js';
import { anchorApproval } from '../approval-hub/helpers.js';

// The earlier child-writer design fails this case: RunLedger.record on the API
// connection waits on the projection's writer lock and freezes every endpoint.
test(
  '400k high-hit approval keeps same-database ledger writes and HTTP health live',
  { timeout: 60_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'entity-publish-scale-'));
    const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
    await store.initialize();
    t.after(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const db = store.getDb();
    await store.upsert([
      { anchor: 'thread-scale', kind: 'thread', status: 'active', title: 'Fixture', updatedAt: '2026-01-01' },
    ]);
    const insert = db.prepare(
      `INSERT INTO evidence_passages (doc_anchor,passage_id,content,created_at) VALUES ('thread-scale',?,'common aliasX text','2026-01-01')`,
    );
    db.transaction(() => {
      for (let i = 0; i < 400_000; i++) insert.run(`msg-${i}`);
    })();
    const ledger = new RunLedger(db);
    const proposals = new InMemoryEntityProposalStore();
    const proposal = proposals.create({
      entityId: 'person:scale',
      entityType: 'person',
      canonicalName: 'Scale',
      aliases: ['aliasX'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'fixture' }],
      rationale: 'Liveness fixture',
      sourceThreadId: 'fixture',
      sourceCatId: 'codex-astra',
      ownerUserId: 'fixture',
    });
    await anchorApproval(proposals, {
      proposalId: proposal.proposalId,
      sourceFeatureId: 'F260',
      ownerUserId: 'fixture',
      requesterCatId: 'codex-astra',
      threadId: 'fixture',
      createdAt: proposal.createdAt,
    });
    const app = Fastify();
    app.get('/health', async () => 'ok');
    registerEntityProposalDecisionRoutes(app, {
      store: proposals,
      upsertEntities: store.upsertEntities.bind(store),
      inspectEntityConflict: store.inspectEntityConflict.bind(store),
      resolveEntityConflict: store.resolveEntityConflict.bind(store),
      socketManager: { emitToUser() {} },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    t.after(() => app.close());
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/health`;
    const health = [];
    const writes = [];
    const publications = [];
    const checkpoints = [];
    const probeStarted = performance.now();
    let phase = 'before-projection';
    let stagedRows = 0;
    let slowestWrite;
    const telemetry = channel('cat-cafe.entity-mention-projection');
    const subscriber = (message) => {
      const event = message;
      phase = event.phase;
      if (event.phase === 'staging') stagedRows = event.rows;
      if (event.phase === 'published') publications.push(event.publishMs);
    };
    telemetry.subscribe(subscriber);
    t.after(() => telemetry.unsubscribe(subscriber));
    const checkpointTelemetry = channel('cat-cafe.entity-mention-checkpoint');
    const onCheckpoint = (result) => checkpoints.push(result);
    checkpointTelemetry.subscribe(onCheckpoint);
    t.after(() => checkpointTelemetry.unsubscribe(onCheckpoint));
    let running = true;
    const probe = (async () => {
      while (running) {
        const started = performance.now();
        assert.equal(await (await fetch(url)).text(), 'ok');
        health.push(performance.now() - started);
        const cpu = process.cpuUsage();
        const writeStart = performance.now();
        ledger.record({
          task_id: 'fixture',
          subject_key: 'fixture:live',
          outcome: 'delivered',
          signal_summary: null,
          duration_ms: 0,
          started_at: Date.now(),
          assigned_cat_id: null,
        });
        const durationMs = performance.now() - writeStart;
        const processCpuUs = process.cpuUsage(cpu);
        writes.push(durationMs);
        if (!slowestWrite || durationMs > slowestWrite.durationMs) {
          slowestWrite = { durationMs, atMs: writeStart - probeStarted, phase, stagedRows, processCpuUs };
        }
        await pause(10);
      }
    })();
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/entity-proposals/${proposal.proposalId}/approve`,
        { method: 'POST', headers: { 'x-cat-cafe-user': 'fixture' } },
      );
      assert.equal(response.status, 200, await response.text());
      assert.equal(proposals.get(proposal.proposalId).status, 'approved');
    } finally {
      running = false;
      await probe;
      t.diagnostic(
        JSON.stringify({
          rows: 400_000,
          healthSamples: health.length,
          healthMaxMs: Math.max(...health),
          ledgerMaxMs: Math.max(...writes),
          publishMaxMs: Math.max(...publications),
          slowestWrite,
          checkpointSamples: checkpoints.length,
          checkpointMaxMs: Math.max(...checkpoints.map((result) => result.durationMs)),
          lastCheckpoint: checkpoints.at(-1),
        }),
      );
    }
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM entity_mentions WHERE entity_id=?').get('person:scale').n,
      400_000,
    );
    assert.ok(health.length > 10);
    assert.ok(writes.length > 10);
    assert.ok(Math.max(...health) < 500, `max health=${Math.max(...health)} ms`);
    assert.ok(Math.max(...writes) < 100, `max main ledger writer=${Math.max(...writes)} ms`);
    assert.ok(Math.max(...publications) < 100, `publication=${Math.max(...publications)} ms`);
    assert.ok(checkpoints.length > 0);
    assert.ok(checkpoints.some((result) => result.busy === 0 && result.log === result.checkpointed));
  },
);
