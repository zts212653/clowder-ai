import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { CompanionHostBridge } from '../src/domains/concierge/live/CompanionHostBridge.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { receipt, work } from './growing/unified-attention-fixtures.js';

function approval(summary = 'Choose the source', createdAt = 10) {
  return {
    decisionRef: 'approval:F221:private-proposal',
    kind: 'approval',
    summary,
    approval: {
      proposalId: 'private-proposal',
      sourceFeatureId: 'F221',
      requesterCatId: 'opus',
      summary,
      createdAt,
      detail: { secret: '/private/internal' },
      inlineApprovable: false,
      navigation: {
        state: 'anchored',
        originRef: { kind: 'message', threadId: 'source-thread', messageId: 'source-message' },
        approvalCardRef: { threadId: 'card-thread', messageId: 'card-message' },
      },
      resolution: 'open',
      materialization: { state: 'not_started' },
    },
    linkedNeedsMe: [],
  };
}

function source(status = 'available', exhaustiveness = 'complete') {
  return { status, exhaustiveness, coverage: 'all_registered_F246_producers', startedAt: 1, observedAt: 2 };
}

function read(items: unknown[] = [approval()]) {
  return {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: 'owner' },
    observedAt: 2,
    sources: { approvals: source(), needsMe: { ...source(), coverage: 'current_linked_F310_five_producers' } },
    readWindow: { startedAt: 1, endedAt: 2, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items,
    totalCount: items.length,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
  };
}

async function fixture() {
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'owner' });
  let current: unknown = read();
  let live = true;
  const paths: string[] = [];
  const opened: object[] = [];
  app.get('/api/concierge/work/decisions', async (request) => {
    paths.push(request.url);
    return current;
  });
  const bridge = new CompanionHostBridge({
    app,
    ownerUserId: 'owner',
    origin: 'http://127.0.0.1:3102',
    publicCompanionV2: true,
    companionContract: '0.1.0-beta.24',
    assertCurrent: async () => {
      if (!live) throw new Error('revoked');
    },
    openConversation: async () => false,
    canOpenDecision: async () => true,
    openDecision: async (destination) => {
      opened.push(destination);
      return true;
    },
  });
  return {
    app,
    bridge,
    paths,
    opened,
    setRead: (value: unknown) => {
      current = value;
    },
    revoke: () => {
      live = false;
    },
  };
}

const command = { kind: 'decisions.read', offset: 0, limit: 20 };

test('a cropped unified summary never exposes half of a UTF-16 surrogate pair', async () => {
  const f = await fixture();
  try {
    f.setRead(read([approval(`${'a'.repeat(499)}🐾 source`)]));
    const reply = await f.bridge.request(command);
    assert.ok('items' in reply);
    assert.equal(reply.items[0]!.summary, 'a'.repeat(499));
  } finally {
    await f.app.close();
  }
});

test('unified Host reads the canonical owner opt-in and emits only cropped public facts', async () => {
  const f = await fixture();
  try {
    const reply = await f.bridge.request(command);
    assert.equal(reply.kind, 'decisions');
    assert.equal('version' in reply && reply.version, 1);
    assert.equal('totalCount' in reply && reply.totalCount, 1);
    assert.match(f.paths[0]!, /view=unified/);
    const serialized = JSON.stringify(reply);
    for (const secret of [
      'private-proposal',
      'source-thread',
      'card-message',
      'F221',
      '/private/internal',
      'ownerUserId',
    ])
      assert.equal(serialized.includes(secret), false, secret);
  } finally {
    await f.app.close();
  }
});

test('partial retains valid rows, source status and unknown total instead of legacy counts', async () => {
  const f = await fixture();
  try {
    const value = read();
    f.setRead({
      ...value,
      status: 'partial',
      totalCount: undefined,
      approvalCount: 99,
      sources: {
        ...value.sources,
        needsMe: { ...source('unavailable', 'unknown'), coverage: 'current_linked_F310_five_producers' },
      },
    });
    const reply = await f.bridge.request(command);
    assert.equal(reply.kind, 'decisions');
    assert.equal('status' in reply && reply.status, 'partial');
    assert.equal('totalCount' in reply, false);
    assert.equal('items' in reply && reply.items.length, 1);
  } finally {
    await f.app.close();
  }
});

test('concrete variants sharing a private logical id receive distinct stable opaque references', async () => {
  const f = await fixture();
  try {
    f.setRead({
      ...read([approval('first', 10), approval('second', 11)]),
      totalCount: undefined,
      consistency: { state: 'uncertain', reasons: ['ambiguous_decision_identity'] },
    });
    const a = await f.bridge.request(command),
      b = await f.bridge.request(command);
    assert.equal(a.kind, 'decisions');
    assert.ok('items' in a && 'items' in b);
    assert.equal(a.items.length, 2);
    assert.notEqual(a.items[0]!.variantRef, a.items[1]!.variantRef);
    assert.deepEqual(
      a.items.map((x) => x.variantRef),
      b.items.map((x) => x.variantRef),
    );
  } finally {
    await f.app.close();
  }
});

test('opening re-reads the exact variant and sends only its current Host-owned source coordinate', async () => {
  const f = await fixture();
  try {
    const first = await f.bridge.request(command);
    assert.ok('items' in first);
    const result = await f.bridge.request({
      kind: 'decision.open',
      variantRef: first.items[0]!.variantRef,
      target: 'approval_card',
    });
    assert.deepEqual(result, { kind: 'navigation', delivery: 'requested' });
    assert.equal(f.paths.length, 2);
    assert.deepEqual(f.opened, [{ threadId: 'card-thread', messageId: 'card-message' }]);
  } finally {
    await f.app.close();
  }
});

test('changed concrete version, foreign owner, unknown refs and revoked lease never navigate', async () => {
  const f = await fixture();
  try {
    const first = await f.bridge.request(command);
    assert.ok('items' in first);
    const open = { kind: 'decision.open', variantRef: first.items[0]!.variantRef, target: 'origin' };
    const replacement = await fixture();
    try {
      await replacement.bridge.request(command);
      assert.deepEqual(await replacement.bridge.request(open), { kind: 'navigation', delivery: 'unconfirmed' });
      assert.deepEqual(replacement.opened, []);
    } finally {
      await replacement.app.close();
    }
    f.setRead(read([approval('changed', 11)]));
    assert.deepEqual(await f.bridge.request(open), { kind: 'navigation', delivery: 'unconfirmed' });
    f.setRead({ ...read(), identity: { ownerUserId: 'foreign' } });
    const foreign = await f.bridge.request(command);
    assert.equal(foreign.kind, 'error');
    assert.equal('code' in foreign && foreign.code, 'permission_required');
    await f.bridge.request({ ...open, variantRef: 'unknown' });
    f.revoke();
    await f.bridge.request(open);
    assert.deepEqual(f.opened, []);
    await f.bridge.close();
    assert.deepEqual(await f.bridge.request(command), { kind: 'error', code: 'cancelled' });
  } finally {
    await f.app.close();
  }
});

test('all unavailable and authentication failures remain unread rather than becoming an exact zero', async () => {
  const f = await fixture();
  try {
    for (const status of ['unavailable', 'unauthenticated', 'forbidden', 'invalid']) {
      const value = read([]);
      f.setRead({
        ...value,
        status: 'unavailable',
        totalCount: undefined,
        sources: {
          approvals: source(status, 'unknown'),
          needsMe: {
            ...source(status, 'unknown'),
            coverage: 'current_linked_F310_five_producers',
          },
        },
      });
      const reply = await f.bridge.request(command);
      assert.equal(reply.kind, 'decisions');
      assert.equal('status' in reply && reply.status, 'unavailable');
      assert.equal('totalCount' in reply, false);
    }
  } finally {
    await f.app.close();
  }
});

test('contradictory pages and unread coverage fail without retaining or issuing a navigation reference', async () => {
  const f = await fixture();
  try {
    const value = read();
    for (const bad of [
      { ...value, page: { ...value.page, hasMore: true } },
      { ...value, totalCount: 2 },
      { ...value, page: { ...value.page, offset: 1 } },
      {
        ...value,
        status: 'partial',
        sources: {
          ...value.sources,
          needsMe: {
            ...value.sources.needsMe,
            status: 'unavailable',
          },
        },
      },
    ]) {
      f.setRead(bad);
      assert.deepEqual(await f.bridge.request(command), { kind: 'error', code: 'unavailable' });
    }
    assert.deepEqual(f.opened, []);
  } finally {
    await f.app.close();
  }
});

test('opening an issued reference cannot bypass the same source semantics enforced on reads', async () => {
  const f = await fixture();
  try {
    const first = await f.bridge.request(command);
    assert.ok('items' in first);
    const value = read();
    f.setRead({
      ...value,
      status: 'partial',
      sources: {
        ...value.sources,
        needsMe: {
          ...value.sources.needsMe,
          status: 'unavailable',
        },
      },
    });
    assert.deepEqual(
      await f.bridge.request({ kind: 'decision.open', variantRef: first.items[0]!.variantRef, target: 'origin' }),
      { kind: 'error', code: 'unavailable' },
    );
    assert.deepEqual(f.opened, []);
  } finally {
    await f.app.close();
  }
});

test('a Needs Me variant retains its canonical producer revision and action, with no raw action authority', async () => {
  const f = await fixture();
  try {
    const r = receipt('choice');
    const ownerRead = work([r]);
    const row = {
      decisionRef: 'f306.runtime_interaction:choice',
      kind: 'judgment',
      summary: r.recommendation,
      linkedNeedsMe: [{ ownerRead, receipt: r }],
    };
    f.setRead(read([row]));
    const reply = await f.bridge.request(command);
    assert.ok('items' in reply);
    assert.deepEqual(reply.items[0]!.navigation.targets, ['action']);
    const open = { kind: 'decision.open', variantRef: reply.items[0]!.variantRef, target: 'action' };
    assert.deepEqual(await f.bridge.request(open), { kind: 'navigation', delivery: 'requested' });
    assert.deepEqual(f.opened, [{ threadId: 'original-thread', messageId: 'choice', blockId: 'card' }]);
    assert.equal(JSON.stringify(reply).includes(r.action.actionRef), false);
    f.setRead(read([{ ...row, kind: 'repair' }]));
    assert.deepEqual(await f.bridge.request(command), { kind: 'error', code: 'unavailable' });
    f.setRead(read([{ ...row, linkedNeedsMe: [] }]));
    assert.deepEqual(await f.bridge.request(command), { kind: 'error', code: 'unavailable' });
  } finally {
    await f.app.close();
  }
});
