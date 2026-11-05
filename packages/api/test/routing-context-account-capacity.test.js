import './helpers/setup-cat-registry.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountCapacityFixture as fixture } from './helpers/account-routing-capacity-fixture.js';

test('credit balances retain their unit and an unreadable concurrent constraint cannot disappear', async (t) => {
  const f = fixture(t);
  f.accounts['main-private-ref'].quota.items.push({
    label: '溢出额度',
    poolId: 'codex-overflow',
    percentKind: 'remaining',
    usedPercent: 20,
  });
  f.save();
  const a = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  const credits = a.candidates
    .find((c) => c.catId === 'first')
    .capacityFacts.current.windows.find((w) => w.kind === 'credits');
  assert.equal(credits.remainingPercent, undefined, '20 credits must not become 20 percent');
  assert.deepEqual(credits.remainingAmount, { value: 20, unit: 'credits' });
  delete f.accounts['main-private-ref'].quota.items[1].percentKind;
  f.save();
  const b = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  assert.equal(b.candidates.find((c) => c.catId === 'first').capacityFacts.current.state, 'unknown');
});

test('catalog shares exact account observations without claiming execution applicability and strips identity', async (t) => {
  const f = fixture(t);
  const model = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  const [first, second] = ['first', 'second'].map((id) => model.candidates.find((c) => c.catId === id));
  assert.equal(first.provenQuotaPools.length, 0);
  assert.deepEqual(first.provenQuotaPools, second.provenQuotaPools);
  assert.equal(first.capacityFacts.current.state, 'fresh');
  assert.equal(first.capacityFacts.current.accountLabel, '主号');
  assert.deepEqual(
    first.capacityFacts.current.windows.map((w) => w.remainingPercent),
    [70, 65],
  );
  assert.deepEqual(
    first.capacityFacts.current.windows.map((w) => w.kind),
    ['five_hour', 'seven_day'],
  );
  assert.ok(first.capacityFacts.current.windows.every((w) => w.applicability === 'unknown'));
  assert.equal(first.capacityFacts.switchRequired.length, 1);
  assert.equal(first.capacityFacts.switchRequired[0].windows[0].remainingPercent, 100);
  assert.ok(!first.provenQuotaPools.some((p) => p.poolId === first.capacityFacts.switchRequired[0].windows[0].poolId));
  const serialized = JSON.stringify(model);
  for (const privateValue of [
    'main-private-ref',
    'spare-private-ref',
    'private-principal',
    'workspace-',
    f.root,
    'id_token',
    'credentialHome',
  ])
    assert.ok(!serialized.includes(privateValue), privateValue);
  const unbound = model.candidates.find((c) => c.catId === 'unbound');
  assert.deepEqual(unbound.provenQuotaPools, []);
  assert.equal(unbound.capacityFacts.current.state, 'unknown');
});

test('quota or binding revisions invalidate catalog digest and account switches use the new principal', async (t) => {
  const f = fixture(t);
  const a = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  f.accounts['main-private-ref'].quota.items[0].usedPercent = 50;
  f.save();
  const b = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  assert.notEqual(a.catalogRevision, b.catalogRevision);
  f.configs.first.accountRef = 'spare-private-ref';
  const c = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  assert.notEqual(b.catalogRevision, c.catalogRevision);
  assert.notEqual(
    b.candidates.find((x) => x.catId === 'first').capacityFacts.current.windows[0].poolId,
    c.candidates.find((x) => x.catId === 'first').capacityFacts.current.windows[0].poolId,
  );
});

test('main, Spark, review and overflow observations never grant a pool binding, even with an exact account revision', async (t) => {
  const f = fixture(t);
  const quota = f.accounts['main-private-ref'].quota;
  quota.items.push(
    { ...quota.items[0], label: 'Spark 5小时使用限额', poolId: 'codex-spark', usedPercent: 100 },
    { ...quota.items[0], label: '代码审查', poolId: 'codex-review', usedPercent: 100 },
    { label: '溢出额度', poolId: 'codex-overflow', percentKind: 'remaining', usedPercent: 0 },
  );
  f.save();
  const a = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  const first = a.candidates.find((c) => c.catId === 'first');
  const c = await f.source.load({
    ownerId: 'owner',
    observedAt: f.now,
    executionBindings: [{ catId: 'first', accountRevision: first.capacityFacts.current.bindingRevision }],
  });
  const bound = c.candidates.find((candidate) => candidate.catId === 'first');
  assert.deepEqual(bound.provenQuotaPools, []);
  assert.deepEqual(
    [...new Set(bound.capacityFacts.current.windows.map((w) => w.poolKind))],
    ['codex-main', 'codex-spark', 'codex-review', 'codex-overflow'],
  );
  assert.ok(bound.capacityFacts.current.windows.every((w) => w.applicability === 'unknown'));
  const { reduceRoutingContext } = await import('../dist/domains/routing-context/routing-context-reducer.js');
  const signalEvents = bound.capacityFacts.current.windows.map((window, i) => ({
    v: 1,
    eventId: `pool-block-${i}`,
    commandId: `pool-block-${i}`,
    ownerId: 'owner',
    subjectRef: { type: 'quota_pool', poolId: window.poolId },
    eventType: 'asserted',
    state: 'unavailable',
    source: 'quota_probe',
    reasonCode: 'quota_exhausted',
    observedAt: f.now,
    validUntil: f.now + 10000,
    evidenceRef: `quota:${i}`,
  }));
  const snapshot = reduceRoutingContext({
    ownerId: 'owner',
    observedAt: f.now,
    catalogRevision: c.catalogRevision,
    candidates: [bound],
    profiles: [],
    signalEvents,
    preferenceRevisions: [],
  });
  assert.equal(snapshot.candidates[0].availability, 'available', 'account observations cannot bind any pool');
});

test('a reset in one unproven pool does not make independent account observations stale', async (t) => {
  const f = fixture(t);
  const quota = f.accounts['main-private-ref'].quota;
  quota.items.push({
    ...quota.items[0],
    label: '代码审查',
    poolId: 'codex-review',
    resetsAt: new Date(f.now - 1).toISOString(),
  });
  f.save();
  const catalog = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  const current = catalog.candidates.find((c) => c.catId === 'first').capacityFacts.current;
  assert.equal(current.state, 'fresh', 'the account observation itself is current');
  assert.equal(current.windows.find((w) => w.poolKind === 'codex-main').freshness, 'fresh');
  assert.equal(current.windows.find((w) => w.poolKind === 'codex-review').freshness, 'stale');
  assert.ok(current.validUntil > f.now, 'an unrelated pool reset does not invalidate the observation cache');
});

test('an unpinned native principal cannot borrow a revision-only execution proof', async (t) => {
  const f = fixture(t);
  const account = f.accounts['main-private-ref'];
  account.envVars = { CODEX_HOME: account.codex.credentialHome };
  delete account.codex;
  f.save();
  const a = await f.source.load({ ownerId: 'owner', observedAt: f.now });
  const reading = a.candidates.find((c) => c.catId === 'first').capacityFacts.current;
  assert.equal(reading.state, 'fresh', 'A can prove a current observed login');
  const c = await f.source.load({
    ownerId: 'owner',
    observedAt: f.now,
    executionBindings: [{ catId: 'first', accountRevision: reading.bindingRevision }],
  });
  assert.equal(
    c.candidates.find((c) => c.catId === 'first').capacityFacts.current.state,
    'unknown',
    'the legacy launch revision contains paths but no frozen principal',
  );
});

test('a different app owner cannot read account labels, readings or pool identity through a catalog', async (t) => {
  const f = fixture(t);
  const denied = await f.source.load({ ownerId: 'different-owner', observedAt: f.now });
  for (const candidate of denied.candidates) {
    assert.deepEqual(candidate.provenQuotaPools, []);
    assert.equal(candidate.capacityFacts.current.state, 'unknown');
    assert.equal(candidate.capacityFacts.current.accountLabel, undefined);
    assert.deepEqual(candidate.capacityFacts.switchRequired, []);
  }
});

test('the carrier stays frozen across a later account switch and cannot consume that account quota', async (t) => {
  const f = fixture(t);
  const { freezeExecutionAccountBinding } = await import(
    '../dist/domains/cats/services/agents/invocation/execution-account-binding.js'
  );
  const carrier = freezeExecutionAccountBinding({
    catId: 'first',
    catConfig: { ...f.configs.first, mcpSupport: false },
    workspace: { usesDefaultWorkspace: false, workingProjectRoot: f.root },
  });
  assert.equal(carrier.resolvedAccount.id, 'main-private-ref');
  // This account-only fixture models an admitted Host with MCP disabled.
  const executionBinding = Object.freeze({
    ...carrier,
    sharedMcpLaunch: Object.freeze({ transport: 'shared' }),
  });
  assert.ok(Object.isFrozen(carrier.resolvedAccount.codex.identity));
  assert.equal(carrier.executionAccount.accountRevision, carrier.codexAccountLaunch.accountRevision);
  const a = await f.source.load({
    ownerId: 'owner',
    observedAt: f.now,
    executionBindings: [{ catId: 'first', accountRevision: carrier.executionAccount.accountRevision }],
  });
  assert.equal(a.candidates.find((c) => c.catId === 'first').capacityFacts.current.state, 'fresh');
  f.configs.first.accountRef = 'spare-private-ref';
  const b = await f.source.load({
    ownerId: 'owner',
    observedAt: f.now,
    executionBindings: [{ catId: 'first', accountRevision: carrier.executionAccount.accountRevision }],
  });
  const frozenReading = b.candidates.find((c) => c.catId === 'first').capacityFacts.current;
  assert.equal(frozenReading.state, 'fresh', 'account owner can still prove the frozen account after a config switch');
  assert.equal(
    frozenReading.windows[0].remainingPercent,
    70,
    'the new account 100% never replaces the frozen account reading',
  );
  assert.equal(carrier.resolvedAccount.id, 'main-private-ref');
  assert.equal(carrier.catConfig.accountRef, 'main-private-ref');
  const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
  let consumed;
  const service = {
    async *invoke(_prompt, options) {
      consumed = options.executionAccount;
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
  for await (const _event of invokeSingleCat(
    {
      registry: { create: () => ({ invocationId: 'fixture-invocation', callbackToken: 'fixture-token' }) },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:1',
    },
    {
      catId: 'codex',
      userId: 'owner',
      ownerAuthProvenance: 'unknown',
      threadId: 'fixture-thread',
      prompt: 'Controlled frozen carrier regression',
      service,
      isLastCat: true,
      executionBinding,
    },
  )) {
    /* actual provider boundary */
  }
  assert.equal(consumed.accountRevision, carrier.executionAccount.accountRevision);
  assert.equal(consumed.accountRef, 'main-private-ref');
});

for (const mode of ['legacy', 'principal-mismatch', 'failed-refresh', 'old', 'reset-passed', 'execution-mismatch'])
  test(`unproven or expired capacity is never current usable quota: ${mode}`, async (t) => {
    const f = fixture(t);
    const a = f.accounts['main-private-ref'];
    if (mode === 'legacy') delete a.quota.owner;
    if (mode === 'principal-mismatch') a.quota.owner.userId = 'different';
    if (mode === 'failed-refresh') {
      a.quota.lastSuccess = { observedAt: a.quota.observedAt, items: a.quota.items };
      a.quota.items = [];
      a.quota.status = 'unavailable';
    }
    if (mode === 'old') a.quota.observedAt = f.now - 86400000;
    if (mode === 'reset-passed') a.quota.items[0].resetsAt = new Date(f.now - 1).toISOString();
    f.save();
    const m = await f.source.load({
      ownerId: 'owner',
      observedAt: f.now,
      ...(mode === 'execution-mismatch'
        ? { executionBindings: [{ catId: 'first', accountRevision: '0'.repeat(64) }] }
        : {}),
    });
    const current = m.candidates.find((x) => x.catId === 'first').capacityFacts.current;
    if (mode === 'reset-passed') {
      assert.equal(current.state, 'fresh', 'the observation is fresh, independent windows may have reset');
      assert.equal(current.windows[0].freshness, 'stale');
      assert.equal(current.windows[1].freshness, 'fresh');
      return;
    }
    assert.notEqual(current.state, 'fresh');
    if (['legacy', 'principal-mismatch', 'execution-mismatch'].includes(mode)) assert.equal(current.state, 'unknown');
    else assert.equal(current.state, 'stale');
  });
