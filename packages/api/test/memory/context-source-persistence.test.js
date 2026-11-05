import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ContextEpochOwner } from '../../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { ContextSourceOpportunityStore } from '../../dist/domains/memory/cue/ContextSourceOpportunityStore.js';
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../../dist/domains/memory/schema.js';

test('source reservations and provider commit persist without source bodies or TTL', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'f321-persistence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'memory.db');
  let db = new Database(path);
  applyMigrations(db);
  assert.ok(CURRENT_SCHEMA_VERSION >= 68);
  const record = {
    opportunityId: 'opportunity',
    scopeKey: 'owner::cat::thread',
    contextEpoch: 1,
    sourceMessageId: 'source',
    consumerCatId: 'cat',
    variant: 'fresh_context_sources',
    evidence: { transition: 'fresh', reason: 'no_prior_session', evidenceRef: 'native' },
    ingress: { kind: 'owner', sourceMessageId: 'source' },
    authorityDigest: 'a'.repeat(64),
    occurredAt: 1,
    expiresAt: 300001,
    committed: false,
  };
  new ContextSourceOpportunityStore(db).prepare(record);
  db.close();
  db = new Database(path);
  t.after(() => db.close());
  applyMigrations(db);
  const reopened = new ContextSourceOpportunityStore(db);
  assert.deepEqual(reopened.get('opportunity'), record);
  reopened.markProviderCommitted('opportunity', 'generation');
  assert.equal(reopened.get('opportunity').committed, true);
  const columns = db
    .prepare('PRAGMA table_info(memory_cue_context_opportunities)')
    .all()
    .map((row) => row.name);
  assert.ok(!columns.some((column) => /body|content|title|summary|query/.test(column)));
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version, CURRENT_SCHEMA_VERSION);
});

test('authoritative compaction proof survives resume until provider consumption; replay never invents a new edge', async () => {
  const scope = { userId: 'owner', catId: 'cat', threadId: 'thread' };
  const owner = new ContextEpochOwner(new InMemoryContextEpochStore());
  const fresh = await owner.resolve({
    ...scope,
    disposition: { state: 'fresh', reason: 'no_prior_session', evidenceRef: 'start', runtimeSessionId: 'runtime' },
  });
  await owner.confirmColdConsumed({ ...scope, contextEpoch: fresh.contextEpoch });
  const event = { eventId: 'compact-event', evidenceRef: 'provider-event', runtimeSessionId: 'runtime' };
  const compacted = await owner.observeCompaction({ ...scope, event });
  assert.equal(compacted.transition, 'context_compacted');
  const resumed = await owner.resolve({
    ...scope,
    disposition: {
      state: 'resumed',
      reason: 'resume_confirmed',
      evidenceRef: 'later-resume',
      runtimeSessionId: 'runtime',
    },
  });
  assert.deepEqual(resumed.pendingCompaction, event);
  assert.equal(resumed.lastTransitionRef, 'later-resume');
  const replay = await owner.observeCompaction({ ...scope, event });
  assert.equal(replay.transition, 'context_compaction_replay');
  assert.equal(replay.contextEpoch, compacted.contextEpoch);
  await owner.confirmColdConsumed({ ...scope, contextEpoch: compacted.contextEpoch });
  const hot = await owner.resolve({
    ...scope,
    disposition: {
      state: 'resumed',
      reason: 'resume_confirmed',
      evidenceRef: 'hot-resume',
      runtimeSessionId: 'runtime',
    },
  });
  assert.equal(hot.pendingCompaction, undefined);
});
