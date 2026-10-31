import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApprovalProducerId, SettledApprovalItem } from '@cat-cafe/shared';
import Fastify from 'fastify';
import {
  ApprovalProducerRegistry,
  bindLegacyApprovalProducer,
} from '../../src/domains/approval-hub/ApprovalProducerRegistry.js';
import { readApprovalHistoryPage } from '../../src/domains/approval-hub/approval-history-page.js';
import type { IApprovalAdapter } from '../../src/domains/approval-hub/ports/IApprovalAdapter.js';
import { approvalHubRoutes } from '../../src/routes/approval-hub-routes.js';
import { compareHistoryPosition } from '../../src/utils/settled-history-page.js';

const item = (feature: ApprovalProducerId, index: number, at = 1000): SettledApprovalItem => ({
  proposalId: `p-${String(index).padStart(4, '0')}`,
  sourceFeatureId: feature,
  ownerUserId: 'owner',
  requesterCatId: 'codex61-sol',
  status: index % 2 ? 'approved' : 'rejected',
  summary: `Actual subject ${index}`,
  detail: { title: `Actual subject ${index}` },
  navigation: { state: 'legacy_unanchored' },
  createdAt: 1,
  decidedAt: at,
  decidedBy: 'owner',
});
function fixture() {
  let records = Array.from({ length: 251 }, (_, index) => item(index % 2 ? 'F128' : 'F221', index));
  let legacyReads = 0,
    pageReads = 0;
  let fail: string | null = null;
  const adapter = (id: ApprovalProducerId): IApprovalAdapter => ({
    featureId: id,
    listPending: () => [],
    listSettled: () => {
      legacyReads++;
      return [];
    },
    listSettledPage: async (owner, options) => {
      pageReads++;
      if (fail === id) throw Object.assign(new Error('source preparing'), { statusCode: 503 });
      assert.equal(owner, 'owner');
      const rows = records
        .filter(
          (record) =>
            record.sourceFeatureId === id &&
            (!options.before ||
              record.decidedAt < options.before.decidedAt ||
              (record.decidedAt === options.before.decidedAt &&
                (options.before.proposalId === null || record.proposalId < options.before.proposalId))),
        )
        .sort((a, b) => compareHistoryPosition(a, b));
      const scanned = rows.slice(0, options.limit);
      return {
        records: scanned,
        frontier: scanned.at(-1)
          ? { decidedAt: scanned.at(-1)?.decidedAt, proposalId: scanned.at(-1)?.proposalId }
          : null,
        hasMore: rows.length > options.limit,
      };
    },
  });
  const registry = new ApprovalProducerRegistry({
    F128: bindLegacyApprovalProducer(adapter('F128')),
    F221: bindLegacyApprovalProducer(adapter('F221')),
  });
  return {
    registry,
    get records() {
      return records;
    },
    set records(value) {
      records = value;
    },
    get legacyReads() {
      return legacyReads;
    },
    get pageReads() {
      return pageReads;
    },
    set fail(value: string | null) {
      fail = value;
    },
  };
}

test('new owner page route is bounded and leaves legacy settled reads untouched', async (t) => {
  const f = fixture(),
    app = Fastify();
  t.after(() => app.close());
  await app.register(approvalHubRoutes, { registry: f.registry });
  const unauthorized = await app.inject({ url: '/api/approval-hub/settled/page' });
  assert.equal(unauthorized.statusCode, 401);
  const response = await app.inject({ url: '/api/approval-hub/settled/page', headers: { 'x-cat-cafe-user': 'owner' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().count, 30);
  assert.equal(response.json().page.hasMore, true);
  assert.equal(f.legacyReads, 0);
  assert.equal(f.pageReads, 2);
});

test('global continuation crosses 200 and source ties, tolerating deleted anchor and a new head', async () => {
  const f = fixture();
  const expected = [...f.records].sort(
    (a, b) =>
      b.decidedAt - a.decidedAt ||
      b.sourceFeatureId.localeCompare(a.sourceFeatureId) ||
      b.proposalId.localeCompare(a.proposalId),
  );
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await readApprovalHistoryPage(f.registry, 'owner', { cursor });
    seen.push(...page.items.map((row) => `${row.sourceFeatureId}:${row.proposalId}`));
    if (!cursor) {
      const anchor = page.items.at(-1)!;
      f.records = f.records.filter(
        (record) => record.sourceFeatureId !== anchor.sourceFeatureId || record.proposalId !== anchor.proposalId,
      );
      f.records.push(item('F128', 999, 1001));
    }
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(
    seen,
    expected.map((row) => `${row.sourceFeatureId}:${row.proposalId}`),
  );
  assert.equal(new Set(seen).size, 251);
  assert.equal(f.legacyReads, 0);
});

test('server filters advance empty windows and cursors reject owner, filter, version and malformed changes', async () => {
  const f = fixture();
  const first = await readApprovalHistoryPage(f.registry, 'owner', { producer: 'F221', resolution: 'accepted' });
  assert.deepEqual(first.items, []);
  assert.equal(first.page.hasMore, true, 'a filtered page is not the end of history');
  const cursor = first.page.nextCursor!;
  await assert.rejects(
    readApprovalHistoryPage(f.registry, 'other', { producer: 'F221', resolution: 'accepted', cursor }),
    { statusCode: 400 },
  );
  await assert.rejects(
    readApprovalHistoryPage(f.registry, 'owner', { producer: 'F128', resolution: 'accepted', cursor }),
    { statusCode: 400 },
  );
  await assert.rejects(readApprovalHistoryPage(f.registry, 'owner', { cursor: 'not json' }), { statusCode: 400 });
  const changed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  changed.v = 2;
  await assert.rejects(
    readApprovalHistoryPage(f.registry, 'owner', {
      producer: 'F221',
      resolution: 'accepted',
      cursor: Buffer.from(JSON.stringify(changed)).toString('base64url'),
    }),
    { statusCode: 400 },
  );
});

test('an unavailable source fails the page closed after sibling reads finish', async () => {
  const f = fixture();
  f.fail = 'F221';
  await assert.rejects(readApprovalHistoryPage(f.registry, 'owner', {}), {
    statusCode: 503,
    code: 'APPROVAL_HISTORY_UNAVAILABLE',
  });
  assert.equal(f.pageReads, 2);
});

test('a missing canonical producer is unavailable, never a complete empty history', async () => {
  const { F266ApprovalAdapter } = await import('../../src/domains/approval-hub/adapters/F266ApprovalAdapter.js');
  const { F276ApprovalAdapter } = await import('../../src/domains/approval-hub/adapters/F276ApprovalAdapter.js');
  for (const adapter of [new F266ApprovalAdapter(), new F276ApprovalAdapter(null)])
    await assert.rejects(adapter.listSettledPage('owner', { limit: 30 }), { statusCode: 503 });
});
