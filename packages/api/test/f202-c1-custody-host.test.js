import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalInput, digest, fixture } from './helpers/custody-host-fixture.js';

for (const [method, value, expected] of [
  ['canonicalize', canonicalInput, { digest }],
  [
    'preflight',
    { leaseId: 'missing', generation: 1, terminalPredicateDigest: digest },
    { ok: false, reason: 'lease_missing' },
  ],
  [
    'complete',
    {
      leaseId: 'missing',
      generation: 1,
      evidenceRefs: ['github:https://github.com/owner/repo/pull/42#pullrequestreview-1'],
    },
    { outcome: 'stale', reason: 'lease_missing' },
  ],
]) {
  test(`production module exposes native custody.${method} with real invocation context`, async (t) => {
    const f = await fixture(t);
    const response = await f.call(method, value);
    assert.equal(response.available, true, `Host custody.${method} is unavailable`);
    assert.deepEqual(response.result, expected);
  });
}

test('saved Host custody refuses background calls and absent Host services', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.host().custody.canonicalize(canonicalInput), /native invocation/);
  const absent = await fixture(t, { unavailable: true });
  await assert.rejects(() => absent.call('canonicalize', canonicalInput), /services unavailable/);
});

test('custody accepts only closed plain protocol data, never caller identity or verdict', async (t) => {
  const f = await fixture(t);
  for (const field of ['catId', 'userId', 'now', 'verdict', 'binding', 'verified']) {
    await assert.rejects(() => f.call('canonicalize', { ...canonicalInput, [field]: 'forged' }));
    await assert.rejects(() =>
      f.call('complete', { leaseId: 'missing', generation: 1, evidenceRefs: ['github:x'], [field]: 'forged' }),
    );
  }
  let reads = 0;
  const malicious = { ...canonicalInput };
  Object.defineProperty(malicious, 'extra', {
    enumerable: true,
    get() {
      reads++;
      return 'forged';
    },
  });
  await assert.rejects(() => f.call('canonicalize', malicious), /own enumerable data/);
  assert.equal(reads, 0);
  await assert.rejects(() => f.call('canonicalize', { ...canonicalInput, predicate: { kind: 'task_done' } }));
});

test('native custody completes through independent verifier and Host state machine, then reauthorizes replay', async (t) => {
  const f = await fixture(t);
  const fence = await f.claim();
  const preflight = await f.call('preflight', { ...fence, terminalPredicateDigest: digest });
  assert.deepEqual(preflight.result, { ok: true, reason: 'active' });
  const input = { ...fence, evidenceRefs: ['github:https://github.com/owner/repo/pull/42#pullrequestreview-1'] };
  assert.deepEqual((await f.call('complete', input)).result, { outcome: 'committed', ...fence });
  assert.equal(f.verifierCalls(), 1);
  assert.equal(f.lastCompletionInput().catId, 'reviewer');
  assert.ok(f.lastCompletionInput().now > 100);
  assert.equal(f.storedLease().status, 'completed');
  assert.equal((await f.call('complete', input)).result.outcome, 'committed');
  assert.equal(f.verifierCalls(), 1, 'durable success replay need not manufacture another provider verdict');
  await assert.rejects(() => f.call('complete', input, { catId: 'other' }), /does not belong/);
  await f.revoke();
  await assert.rejects(() => f.call('complete', input), /no longer current|custody.invoke/);
});

test('preflight preserves generation and digest fences and rejects foreign or legacy leases', async (t) => {
  const f = await fixture(t);
  const fence = await f.claim();
  assert.deepEqual(
    (await f.call('preflight', { ...fence, generation: fence.generation + 1, terminalPredicateDigest: digest })).result,
    { ok: false, reason: 'stale_generation' },
  );
  assert.deepEqual((await f.call('preflight', { ...fence, terminalPredicateDigest: 'b'.repeat(64) })).result, {
    ok: false,
    reason: 'predicate_mismatch',
  });
  const original = f.storedLease();
  for (const patch of [
    { tenantScope: 'other' },
    { holderThreadId: 'other' },
    { terminalPredicateProviderBinding: undefined },
    { terminalPredicateProviderBinding: { ...original.terminalPredicateProviderBinding, pluginInstanceId: 'other' } },
  ]) {
    f.setLease({ ...original, ...patch });
    await assert.rejects(() => f.call('preflight', { ...fence, terminalPredicateDigest: digest }), /does not belong/);
    await assert.rejects(() => f.call('complete', { ...fence, evidenceRefs: ['github:x'] }), /does not belong/);
  }
});

test('revocation during real verifier IO prevents success commit and recursive custody calls', async (t) => {
  const f = await fixture(t);
  const fence = await f.claim();
  f.onVerify(() => f.revoke());
  await assert.rejects(() =>
    f.call('complete', {
      ...fence,
      evidenceRefs: ['github:https://github.com/owner/repo/pull/42#pullrequestreview-1'],
    }),
  );
  assert.equal(f.verifierCalls(), 1);
  assert.equal(f.storedLease().status, 'active');
  assert.notEqual(f.storedLease().holderOutcomes.reviewer?.outcome, 'succeeded');
});
