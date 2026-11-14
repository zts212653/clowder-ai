import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECALL_OPPORTUNITY_CATALOG_VERSION } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import {
  MemoryCueEpisodeStore,
  memoryCueEventInputSchema,
} from '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

const scope = { ownerUserId: 'owner', threadId: 'thread', invocationId: 'inv' };
const coordinate = {
  cueId: 'prep-cue',
  opportunityId: 'preparation-received',
  scope,
  consumerCatId: 'codex61-sol',
  resolverFamily: 'project_knowledge',
  resolverVersion: 1,
  catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
  family: 'evidence',
  anchor: 'F332',
  revision: 'rev1',
  expiresAt: 10000,
};

test('an explicit preparation read is a named, atomic branch in the original receipt ledger', () => {
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    const store = new MemoryCueEpisodeStore(db);
    const event = {
      eventId: 'explicit',
      idempotencyKey: 'explicit',
      cueId: coordinate.cueId,
      opportunityId: coordinate.opportunityId,
      scope,
      consumerCatId: coordinate.consumerCatId,
      resolverFamily: coordinate.resolverFamily,
      resolverVersion: 1,
      catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
      sourceAnchor: coordinate.anchor,
      sourceRevision: coordinate.revision,
      axis: 'consumption',
      consumptionOutcome: 'presented',
      occurredAt: 1000,
      readOrigin: 'explicit_read',
    };
    assert.equal(memoryCueEventInputSchema.safeParse(event).success, true);
    assert.equal(memoryCueEventInputSchema.safeParse({ ...event, opportunityId: 'ordinary-push' }).success, false);
    const atomic = store;

    assert.deepEqual(store.listByCue('owner', coordinate.cueId), []);
    atomic.appendPreparationRead({ coordinate, requestId: 'read-1', occurredAt: 2000 });
    atomic.appendPreparationRead({ coordinate, requestId: 'read-1', occurredAt: 2500 });
    const events = store.listByCue('owner', coordinate.cueId);
    assert.deepEqual(
      events.map((e) => e.consumptionOutcome),
      ['presented', 'drilled'],
    );
    assert.deepEqual(
      events.map((e) => e.occurredAt),
      [2000, 2000],
    );
    assert.ok(events.every((e) => e.readOrigin === 'explicit_read'));
  } finally {
    db.close();
  }
});
