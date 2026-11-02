import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { ScheduleMutationProposalStore } from '../../src/infrastructure/scheduler/ScheduleMutationProposalStore.js';

test('real schedule store pages >200 tied decisions with range seeks and survives removal of its cursor anchor', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const store = new ScheduleMutationProposalStore(db);
  try {
    const ids = Array.from({ length: 251 }, (_, i) => `schedule-${String(i).padStart(4, '0')}`);
    for (const id of ids) {
      store.create({
        proposalId: id,
        ownerUserId: 'owner',
        requesterCatId: 'codex61-sol',
        status: 'pending',
        createdAt: 1,
        publication: { state: 'staged', stagedAt: 1 },
        mutation: {
          kind: 'create',
          task: {
            id: `task-${id}`,
            templateId: 'reminder',
            trigger: { type: 'once', fireAt: 9000 },
            params: { message: 'fixture' },
            display: { label: 'Fixture' },
            enabled: true,
            createdBy: 'codex61-sol',
            createdAt: '2026-10-27T12:00:00.000Z',
          },
        },
      });
      assert.ok(store.reject(id, 'owner', 'Not now', 1000));
    }
    let page = store.listSettledPage('owner', { limit: 30 });
    const seen = page.records.map((item) => item.proposalId);
    db.prepare('DELETE FROM schedule_mutation_proposals WHERE proposal_id=?').run(page.frontier?.proposalId);
    for (; page.hasMore; ) {
      page = store.listSettledPage('owner', { limit: 30, before: page.frontier! });
      seen.push(...page.records.map((item) => item.proposalId));
    }
    assert.deepEqual(seen, [...ids].reverse());
    assert.deepEqual(store.listSettledPage('other', { limit: 30 }).records, []);
    const plans = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT proposal_id FROM schedule_mutation_proposals WHERE owner_user_id=? AND status IN ('approved','rejected') AND COALESCE(approved_at,rejected_at,0)=? AND proposal_id COLLATE BINARY<? ORDER BY proposal_id COLLATE BINARY DESC LIMIT ?",
      )
      .all('owner', 1000, 'schedule-0100', 31) as Array<{ detail: string }>;
    assert.ok(
      plans.some(
        (plan) => plan.detail.includes('idx_schedule_mutation_settled_page') && plan.detail.includes('<expr>'),
      ),
    );
    assert.ok(plans.every((plan) => !plan.detail.includes('TEMP B-TREE')));
  } finally {
    db.close();
  }
});
