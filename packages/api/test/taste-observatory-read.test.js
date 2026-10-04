import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

const PUBLIC_PATH = 'docs/taste/vignettes/visual-quality-ELI5-pcpjsd.md';
const PRIVATE_PATH = 'private/taste/private.md';
const F315_PATH = 'docs/taste/vignettes/visual-quality-用户视角-qebr8h.md';
const CUE_ANCHOR = `taste-vignette:${PUBLIC_PATH}`;
const SEARCH_ANCHOR = 'doc:taste/vignettes/visual-quality-ELI5-pcpjsd';
let seq = 0;

function vignette(privacy, quote) {
  return `---
when: 2026-09-26
quotes: ["${quote}"]
scene: "private or public scene"
tags: ["ELI5", "HTML富文本", "可视化优先"]
dimension: visual-quality
privacy: ${privacy}
catId: codex6-sol
proposalId: proposal-1
---
`;
}

function cue(outcome, overrides = {}) {
  seq += 1;
  return {
    eventId: `event-${seq}`,
    idempotencyKey: `key-${seq}`,
    cueId: 'cue-1',
    opportunityId: `opportunity-${seq}`,
    scope: { ownerUserId: 'owner', threadId: 'thread-owner', invocationId: 'inv-owner' },
    consumerCatId: 'kimi',
    resolverFamily: 'taste',
    sourceAnchor: CUE_ANCHOR,
    sourceRevision: 'rev-1',
    axis: 'consumption',
    consumptionOutcome: outcome,
    catalogVersion: 1,
    resolverVersion: 1,
    occurredAt: 1000 + seq,
    ...overrides,
  };
}

describe('F321 A1c owner-scoped Taste observatory read model', () => {
  let app;
  let db;
  let root;
  let store;
  let children;
  let canonicalRootCalls;

  beforeEach(async () => {
    seq = 0;
    root = mkdtempSync(join(tmpdir(), 'f321-observatory-'));
    mkdirSync(join(root, 'docs/taste/vignettes'), { recursive: true });
    mkdirSync(join(root, 'private/taste'), { recursive: true });
    writeFileSync(join(root, PUBLIC_PATH), vignette('public', 'PUBLIC QUOTE'));
    writeFileSync(join(root, PRIVATE_PATH), vignette('sensitive', 'OWNER SECRET QUOTE'));

    const { applyMigrations } = await import('../dist/domains/memory/schema.js');
    const { MemoryCueEpisodeStore } = await import('../dist/domains/memory/cue/MemoryCueEpisodeStore.js');
    const { tasteObservatoryRoutes } = await import('../dist/routes/taste-observatory.js');
    db = new Database(':memory:');
    applyMigrations(db);
    store = new MemoryCueEpisodeStore(db);
    const invocations = new Map([
      ['inv-owner', { id: 'inv-owner', userId: 'owner', threadId: 'thread-owner' }],
      ['inv-other', { id: 'inv-other', userId: 'other', threadId: 'thread-owner' }],
    ]);
    children = new Map();
    canonicalRootCalls = 0;
    const threads = new Map([
      ['thread-owner', { id: 'thread-owner', createdBy: 'owner' }],
      ['thread-owner-2', { id: 'thread-owner-2', createdBy: 'owner' }],
      ['thread-other', { id: 'thread-other', createdBy: 'other' }],
      ['default', { id: 'default', createdBy: 'system' }],
    ]);
    app = Fastify({ logger: false });
    await app.register(tasteObservatoryRoutes, {
      evidenceDb: db,
      tasteRepository: {
        canonicalRoot: () => {
          canonicalRootCalls += 1;
          return root;
        },
        approvalLockKey: () => 'unused',
      },
      privateOwnerUserId: 'owner',
      threadStore: { get: async (id) => threads.get(id) ?? null },
      invocationRecordStore: { get: async (id) => invocations.get(id) ?? null },
      turnExecutionStore: { get: async (id) => children.get(id) ?? null },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function get(userId = 'owner', extraHeaders = {}) {
    return app.inject({
      method: 'GET',
      url: '/api/memory/taste/observatory',
      headers: { 'x-cat-cafe-user': userId, ...extraHeaders },
    });
  }

  it('the owner browse consumer can restrict the snapshot to public without exposing private entry metadata', async () => {
    const { TasteObservatoryReader } = await import('../dist/domains/memory/taste/TasteObservatoryReader.js');
    const reader = new TasteObservatoryReader(
      db,
      { canonicalRoot: () => root, approvalLockKey: () => 'unused' },
      'owner',
      { get: async () => null },
      { get: async () => null },
      { get: async () => null },
    );
    const restricted = await reader.read('owner', { includePrivate: false });
    assert.equal(restricted.entries.length, 1);
    assert.equal(restricted.entries[0].sourcePath, PUBLIC_PATH);
    assert.equal(JSON.stringify(restricted).includes(PRIVATE_PATH), false);
    assert.equal((await reader.read('owner')).entries.length, 2, 'legacy direct-local read remains unchanged');
    assert.equal(
      (await reader.read('other', { includePrivate: true })).entries.length,
      1,
      'option never grants another owner private access',
    );
  });

  function recall(id, invocationId, threadId, candidates, consumed, timestamp) {
    db.prepare(`INSERT INTO recall_events
      (recall_id, cat_id, invocation_id, tool_name, query, candidates_json, consumed_json,
       token_cost, timestamp, thread_id, source)
      VALUES (?, 'kimi', ?, 'search_evidence', 'taste', ?, ?, 0, ?, ?, 'pull')`).run(
      id,
      invocationId,
      JSON.stringify(candidates.map((anchor) => ({ anchor }))),
      JSON.stringify(consumed.map((anchor) => ({ anchor }))),
      timestamp,
      threadId,
    );
  }

  it('folds exact cue, constellation hint and verified pull recall into distinct channels', async () => {
    store.append(cue('presented'));
    store.append(cue('applied'));
    store.append(
      cue('presented', { cueId: 'hint-1', sourceAnchor: 'taste-dimensions:visual-quality,cognitive-honesty' }),
    );
    store.append(
      cue('presented', {
        cueId: 'other-owner',
        scope: { ownerUserId: 'other', threadId: 'thread-other', invocationId: 'inv-other' },
      }),
    );
    recall('owner-recall', 'inv-owner', 'thread-owner', [SEARCH_ANCHOR], [SEARCH_ANCHOR], 2000);
    recall('other-recall', 'inv-other', 'thread-owner', [SEARCH_ANCHOR], [SEARCH_ANCHOR], 3000);
    recall('unverified-recall', 'unknown', 'thread-secret', [SEARCH_ANCHOR], [SEARCH_ANCHOR], 4000);
    recall(
      'unverified-owner-recall',
      'missing-owner-invocation',
      'thread-owner',
      [SEARCH_ANCHOR],
      [SEARCH_ANCHOR],
      5000,
    );

    const response = await get();
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.entries.length, 2);
    assert.equal(canonicalRootCalls, 1);
    const item = body.entries.find((entry) => entry.sourcePath === PUBLIC_PATH);
    assert.deepEqual(item.namedDelivery.counts, { presented: 1, drilled: 0, applied: 1, dismissed: 0 });
    assert.equal(item.namedDelivery.latest.threadId, 'thread-owner');
    assert.deepEqual(item.search, {
      hits: 1,
      opened: 1,
      unverified: 1,
      latest: { threadId: 'thread-owner', recalledAt: 2000, opened: true },
    });
    assert.equal(body.coverage.totalUnverified, 1);
    assert.equal(item.dimensionHint.dimension, 'visual-quality');
    assert.equal(item.dimensionHint.attribution, 'constellation_only');
    assert.equal(body.constellations.find((group) => group.dimension === 'visual-quality').hints.presented, 1);
    assert.equal(body.constellations.find((group) => group.dimension === 'visual-quality').attribution, 'shared_hint');
    assert.equal(body.entries.find((entry) => entry.sourcePath === PRIVATE_PATH).search, null);
    assert.equal(JSON.stringify(body).includes('thread-secret'), false);
  });

  it('keeps private entries and owner-specific counters from another authenticated user', async () => {
    store.append(cue('presented'));
    store.append(
      cue('presented', {
        cueId: 'other-cue',
        scope: { ownerUserId: 'other', threadId: 'thread-other', invocationId: 'inv-other' },
      }),
    );
    recall('other-recall', 'inv-other', 'thread-owner', [SEARCH_ANCHOR], [SEARCH_ANCHOR], 3000);
    const response = await get('other');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().entries.length, 1);
    assert.equal(response.json().entries[0].sourcePath, PUBLIC_PATH);
    assert.equal(response.json().entries[0].namedDelivery.counts.presented, 1);
    assert.equal(response.json().entries[0].search.hits, 1);
    assert.equal(JSON.stringify(response.json()).includes('private.md'), false);
  });

  it('reports the latest verified hit even when an earlier hit was opened', async () => {
    recall('opened-first', 'inv-owner', 'thread-owner', [SEARCH_ANCHOR], [SEARCH_ANCHOR], 2000);
    recall('hit-later', 'inv-owner', 'thread-owner', [SEARCH_ANCHOR], [], 3000);
    const search = (await get()).json().entries.find((entry) => entry.sourcePath === PUBLIC_PATH).search;
    assert.deepEqual(search, {
      hits: 2,
      opened: 1,
      unverified: 0,
      latest: { threadId: 'thread-owner', recalledAt: 3000, opened: false },
    });
  });

  it('uses recall ID to settle same-millisecond hit and open events', async () => {
    recall('z-hit', 'inv-owner', 'thread-owner', [SEARCH_ANCHOR], [], 3000);
    recall('a-opened', 'inv-owner', 'thread-owner', [SEARCH_ANCHOR], [SEARCH_ANCHOR], 3000);
    const search = (await get()).json().entries.find((entry) => entry.sourcePath === PUBLIC_PATH).search;
    assert.deepEqual(search.latest, { threadId: 'thread-owner', recalledAt: 3000, opened: false });
  });

  it('folds a named F315 bundle anchor back to its approved vignette', async () => {
    writeFileSync(join(root, F315_PATH), vignette('public', 'F315 PUBLIC QUOTE'));
    store.append(
      cue('presented', {
        cueId: 'f315-cue',
        sourceAnchor: `taste-task-bundle:f315-workspace-readability-review-v1#${F315_PATH}`,
      }),
    );
    const body = (await get()).json();
    assert.equal(body.entries.length, 3);
    const item = body.entries.find((entry) => entry.sourcePath === F315_PATH);
    assert.equal(item.namedDelivery.trigger, 'f315_review');
    assert.equal(item.namedDelivery.counts.presented, 1);
  });

  it('does not trust a child turn whose parent belongs to another owner', async () => {
    children.set('child-foreign-parent', {
      invocationId: 'child-foreign-parent',
      parentInvocationId: 'inv-other',
      userId: 'owner',
      threadId: 'thread-owner',
    });
    recall('child-recall', 'child-foreign-parent', 'thread-owner', [SEARCH_ANCHOR], [SEARCH_ANCHOR], 5000);
    const body = (await get()).json();
    assert.deepEqual(body.entries.find((entry) => entry.sourcePath === PUBLIC_PATH).search, {
      hits: 0,
      opened: 0,
      unverified: 1,
      latest: null,
    });
  });

  it('does not reveal an unowned search from the shared default thread', async () => {
    recall('shared-unknown', 'missing-shared-invocation', 'default', [SEARCH_ANCHOR], [SEARCH_ANCHOR], 6000);
    const body = (await get()).json();
    const search = body.entries.find((entry) => entry.sourcePath === PUBLIC_PATH).search;
    assert.equal(search.hits, 0);
    assert.equal(search.opened, 0);
    assert.equal(search.unverified, 0);
    assert.equal(body.coverage.totalUnverified, 0);
    assert.equal(body.coverage.sharedUnknownPolicy, 'excluded');
  });

  it('counts a mismatched but owner-created thread as unverified, never as a hit', async () => {
    recall('mismatched-thread', 'inv-owner', 'thread-owner-2', [SEARCH_ANCHOR], [SEARCH_ANCHOR], 7000);
    const body = (await get()).json();
    const search = body.entries.find((entry) => entry.sourcePath === PUBLIC_PATH).search;
    assert.deepEqual([search.hits, search.opened, search.unverified], [0, 0, 1]);
    assert.equal(body.coverage.totalUnverified, 1);
  });

  it('fails closed on anonymous and proxied requests and never returns source bodies', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/memory/taste/observatory' })).statusCode, 401);
    assert.equal((await get('owner', { 'x-forwarded-for': '203.0.113.1' })).statusCode, 401);
    const body = (await get()).json();
    assert.deepEqual(Object.keys(body).sort(), ['constellations', 'coverage', 'entries']);
    for (const forbidden of [
      'PUBLIC QUOTE',
      'OWNER SECRET QUOTE',
      'private or public scene',
      '"quotes"',
      '"scene"',
      '"prompt"',
    ]) {
      assert.equal(JSON.stringify(body).includes(forbidden), false, `response leaked ${forbidden}`);
    }
    assert.equal(body.coverage.scope, 'verified_invocations_and_owner_threads');
    assert.equal(body.coverage.totalUnverified, 0);
  });

  it('reports unavailable canonical public Taste source instead of a false empty catalog', async () => {
    rmSync(join(root, 'docs/taste/vignettes'), { recursive: true });
    assert.equal((await get()).statusCode, 503);
  });
});
