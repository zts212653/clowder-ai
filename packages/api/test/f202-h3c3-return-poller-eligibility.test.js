/**
 * F202 h3c-3 — reply polling needs both the package and exactly one cloud cat (ledger「h3c-3 实现细则
 * v2」P2-1; astra direction review …000548).
 *
 * The package's lease alone is not enough: with no cat, or several, configured for the provider,
 * nobody can receive a return, so there is no timer and nothing is acked. The poller re-reads the
 * cat configuration when told to (`reevaluate()`, after the Host reconciles its cat catalog) even
 * while the lease is unchanged. A return the ingest refuses because the provider has no single cat
 * stays in the package, unacked, until one cat is configured again; a round of a generation that
 * ended meanwhile neither ingests nor acks.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { CloudConversationHostRegistry } from '../dist/domains/plugin/declared/cloud-conversation-host-registry.js';
import { cleanup, METHODS, settle } from './f202-w2-3-h3b.fixture.js';
import { CURSOR, catConfig, fakePackage, methodsOf, pollerFor, RETURN } from './helpers/f202-return-poller-harness.js';

after(cleanup);

const ONE = { 'gpt-pro': { provider: 'openai-chatgpt-pro' } };
const NONE = { codex: { provider: 'openai' } };
const TWO = { 'gpt-pro': { provider: 'openai-chatgpt-pro' }, 'gpt-pro-2': { provider: 'openai-chatgpt-pro' } };

/** The Host ingest's own answer for the configured cats (the real service resolves them the same way). */
function ingestFor(cats) {
  return async () => {
    const cloud = Object.values(cats.getAllConfigs()).filter((cat) => cat.provider === 'openai-chatgpt-pro');
    if (cloud.length === 0) return { status: 'rejected', reason: 'cloud_cat_unavailable' };
    if (cloud.length > 1) return { status: 'rejected', reason: 'cloud_cat_ambiguous' };
    return { status: 'persisted', messageId: 'm-1' };
  };
}

test('an enabled package with no cloud cat is not polled: no timer, no log, until one cat is configured', async () => {
  const registry = new CloudConversationHostRegistry();
  const cats = catConfig(NONE);
  const p = pollerFor(registry, { cats, ingest: ingestFor(cats) });
  const pkg = fakePackage(registry);
  pkg.register();
  p.poller.start();
  assert.deepEqual(p.scheduler.pending(), [], 'no cat: no timer');

  cats.set(TWO);
  p.poller.reevaluate();
  assert.deepEqual(p.scheduler.pending(), [], 'several cats: no timer either');

  cats.set(ONE);
  p.poller.reevaluate();
  assert.deepEqual(p.scheduler.pending(), [0], 'one cat: polled at once, with the same lease');
  await p.scheduler.fire();
  assert.deepEqual(methodsOf(pkg), [METHODS.list]);
  assert.deepEqual(p.lines, []);
});

test('the same lease is re-judged when the cats change: 1 → 0 stops the timer, 0 → 1 starts a new generation', async () => {
  const registry = new CloudConversationHostRegistry();
  const cats = catConfig(ONE);
  const p = pollerFor(registry, { cats, ingest: ingestFor(cats) });
  const pkg = fakePackage(registry);
  pkg.register();
  p.poller.start();
  await p.scheduler.fire();
  assert.deepEqual(p.scheduler.pending(), [1_000]);

  cats.set(NONE);
  p.poller.reevaluate();
  assert.deepEqual(p.scheduler.pending(), [], 'the pending round is cancelled although the lease is unchanged');

  cats.set(ONE);
  p.poller.reevaluate();
  assert.deepEqual(p.scheduler.pending(), [0], 'a new generation starts at once');
});

for (const [label, config] of [
  ['no cat', NONE],
  ['several cats', TWO],
]) {
  test(`a return the ingest refuses for ${label} stays unacked; with one cat again it lands exactly once`, async () => {
    const registry = new CloudConversationHostRegistry();
    const cats = catConfig(ONE);
    const p = pollerFor(registry, { cats, ingest: ingestFor(cats) });
    const pkg = fakePackage(registry);
    pkg.register();
    p.poller.start();
    pkg.answers[METHODS.list] = () => {
      // The configuration changes while this list is in flight.
      cats.set(config);
      return { returns: [RETURN] };
    };

    await p.scheduler.fire();
    assert.deepEqual(methodsOf(pkg), [METHODS.list], 'refused for the provider: not acked');
    assert.deepEqual(p.scheduler.pending(), [], 'polling pauses');

    pkg.answers[METHODS.list] = { returns: [RETURN] };
    cats.set(ONE);
    p.poller.reevaluate();
    await p.scheduler.fire();
    assert.deepEqual(pkg.calls.slice(1), [
      { method: METHODS.list, params: {} },
      { method: METHODS.ack, params: CURSOR },
    ]);
    assert.equal(p.ingested.length, 2, 'the same return is ingested again, now that one cat can receive it');
  });
}

test('a list of an ended generation that returns after the cats recovered neither ingests nor acks', async () => {
  const registry = new CloudConversationHostRegistry();
  const cats = catConfig(ONE);
  const p = pollerFor(registry, { cats, ingest: ingestFor(cats) });
  const pkg = fakePackage(registry);
  pkg.register();
  p.poller.start();
  let answerOldList;
  pkg.answers[METHODS.list] = () =>
    new Promise((resolve) => {
      answerOldList = () => resolve({ returns: [RETURN] });
    });
  await p.scheduler.fire();
  assert.equal(typeof answerOldList, 'function', 'the first generation is listing');

  cats.set(NONE);
  p.poller.reevaluate();
  cats.set(ONE);
  p.poller.reevaluate();
  assert.deepEqual(p.scheduler.pending(), [0], 'the new generation is scheduled');

  answerOldList();
  await settle();
  assert.deepEqual(p.ingested, [], 'the ended generation ingests nothing');
  assert.deepEqual(methodsOf(pkg), [METHODS.list], 'and acks nothing');

  pkg.answers[METHODS.list] = { returns: [RETURN] };
  await p.scheduler.fire();
  assert.deepEqual(methodsOf(pkg), [METHODS.list, METHODS.list, METHODS.ack], 'the new generation acks it once');
  assert.equal(p.ingested.length, 1);
});

test('a round whose ingest answers after a 1 → 0 → 1 change does not ack for the new generation', async () => {
  const registry = new CloudConversationHostRegistry();
  const cats = catConfig(ONE);
  const releases = [];
  const p = pollerFor(registry, {
    cats,
    ingest: () =>
      new Promise((resolve) => {
        releases.push(() => resolve({ status: 'persisted', messageId: 'm-1' }));
      }),
  });
  const pkg = fakePackage(registry);
  pkg.register();
  p.poller.start();
  pkg.answers[METHODS.list] = { returns: [RETURN] };
  await p.scheduler.fire();
  assert.equal(releases.length, 1, 'the first generation is waiting on the ingest');

  cats.set(NONE);
  p.poller.reevaluate();
  cats.set(ONE);
  p.poller.reevaluate();
  assert.deepEqual(p.scheduler.pending(), [0], 'the same lease is current again, in a new generation');

  releases[0]();
  await settle();
  assert.deepEqual(methodsOf(pkg), [METHODS.list], 'the ended generation acks nothing through the current lease');

  const fired = p.scheduler.fire();
  await settle();
  releases[1]();
  await fired;
  await settle();
  assert.deepEqual(methodsOf(pkg), [METHODS.list, METHODS.list, METHODS.ack], 'the new generation acks it once');
});
