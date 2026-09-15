import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { routingSignalClosures } from '@cat-cafe/shared';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { AutomaticRoutingSignalService } from '../dist/domains/routing-context/AutomaticRoutingSignalService.js';
import { RoutingContextResolver } from '../dist/domains/routing-context/RoutingContextResolver.js';
import { RuntimeRoutingDispatchPreflight } from '../dist/domains/routing-context/RoutingDispatchPreflightPort.js';
import { RoutingDispatchSignalAdapter } from '../dist/domains/routing-context/RoutingDispatchSignalAdapter.js';
import { RoutingPreflightService } from '../dist/domains/routing-context/RoutingPreflightService.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

function harness(catIds = ['sol', 'terra']) {
  let now = 10_000;
  const events = [];
  const candidates = catIds.map((catId) => ({ v: 1, catId, providerId: 'openai', provenQuotaPools: [] }));
  const store = {
    async append(event) {
      const existing = events.find((item) => item.commandId === event.commandId && item.ownerId === event.ownerId);
      if (existing) return { outcome: 'replayed', event: existing };
      events.push(event);
      return { outcome: 'appended', event };
    },
    async get(ownerId, eventId) {
      return events.find((event) => event.ownerId === ownerId && event.eventId === eventId) ?? null;
    },
    async getOwnerRevision() {
      return events.length;
    },
    async listByOwner(ownerId) {
      return events.filter((event) => event.ownerId === ownerId);
    },
    async listBySubject(ownerId, subjectRef) {
      return events.filter(
        (event) => event.ownerId === ownerId && JSON.stringify(event.subjectRef) === JSON.stringify(subjectRef),
      );
    },
  };
  const service = new AutomaticRoutingSignalService({ signalStore: store });
  const resolver = new RoutingContextResolver({
    signalStore: store,
    preferenceStore: { listByOwner: async () => [] },
    profileRevisionSource: { load: async () => ({ status: 'fresh', profiles: [] }) },
  });
  const input = () => ({ ownerId: 'owner', observedAt: now, catalogRevision: 'catalog:test', candidates });
  const preflight = new RuntimeRoutingDispatchPreflight({
    catalogSource: { load: async () => input() },
    preflightService: new RoutingPreflightService({ resolver, readBudgetMs: 1_000 }),
    now: () => now,
  });
  const adapter = new RoutingDispatchSignalAdapter({ automaticSignalService: service });
  return {
    events,
    store,
    service,
    adapter,
    preflight,
    time(value) {
      now = value;
    },
    async snapshot() {
      return (await resolver.resolve(input())).snapshot;
    },
    async decide(ownerRequestedAttempt = false) {
      return preflight.preflight({ ownerId: 'owner', targetCatIds: [catIds[0]], ownerRequestedAttempt });
    },
    async negative(id, overrides = {}) {
      return (
        await service.assert({
          ownerId: 'owner',
          observationId: id,
          subjectRef: { type: 'cat', catId: catIds[0] },
          source: 'provider_error',
          state: 'unavailable',
          reasonCode: 'quota_exhausted',
          observedAt: 1_000,
          validUntil: 301_000,
          evidenceRef: `failure:${id}`,
          ...overrides,
        })
      ).event;
    },
    async terminal(preflightDecision, overrides = {}) {
      return adapter.observeTerminal({
        ownerId: 'owner',
        observationId: 'success',
        observedAt: now,
        evidenceRef: 'turn-execution:success',
        catId: catIds[0],
        status: 'succeeded',
        preflightDecision,
        ...overrides,
      });
    },
  };
}

describe('F293 controlled human recovery journey', () => {
  it('runs real dispatch across three threads with a failing then recovered fake provider, without replaying old work', async () => {
    const h = harness(['opus', 'codex']);
    h.time(Date.now());
    let providerFails = true;
    let calls = 0;
    const provider = {
      async *invoke() {
        calls++;
        if (providerFails) {
          yield {
            type: 'error',
            catId: 'opus',
            error: 'quota exhausted',
            metadata: { cliDiagnostics: { reasonCode: 'quota_exceeded' } },
            timestamp: Date.now(),
          };
        } else {
          yield { type: 'text', catId: 'opus', content: '@co-creator\ncompleted', timestamp: Date.now() };
        }
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };
    const { deps, messages } = routingJourneyDeps(h.preflight, h.adapter, provider);
    const send = async (threadId, human = false) => {
      h.time(Date.now());
      const result = [];
      for await (const event of routeSerial(deps, ['opus'], 'original work', 'owner', threadId, {
        parentInvocationId: `parent-${threadId}`,
        currentUserMessageId: `original-${threadId}`,
        ownerAuthProvenance: 'strict',
        humanDispositionInvocationOrigin: human ? 'direct_owner' : 'callback',
      }))
        result.push(event);
      h.time(Date.now());
      return result;
    };
    await send('thread-a', true);
    assert.equal(calls, 1);
    assert.equal((await h.decide()).targets[0].disposition, 'rejected', 'real failed terminal updates routing truth');
    for (const threadId of ['thread-b', 'thread-c']) {
      const events = await send(threadId);
      assert.ok(events.some((event) => event.errorCode === 'routing_preflight_rejected'));
    }
    assert.equal(calls, 1, 'automatic retries are blocked before invoking the provider');
    providerFails = false;
    const attempted = await send('thread-a', true);
    assert.ok(
      attempted.some(
        (event) => event.type === 'system_info' && JSON.parse(event.content).target?.ownerAttempt === true,
      ),
    );
    assert.equal(calls, 2, 'a human attempt reaches the recovered provider');
    assert.equal((await h.decide()).targets[0].disposition, 'allowed');
    assert.equal(calls, 2, 'recovery does not replay either blocked request');
    assert.equal(messages.filter((message) => message.extra?.systemInfo?.payload.retryInvocationId).length, 3);
    await send('thread-b');
    await send('thread-c');
    assert.equal(calls, 4, 'both other threads can send again through the same resolver');
  });

  it('warns and really permits an owner attempt while the same automatic target remains rejected', async () => {
    const h = harness();
    await h.negative('old');
    assert.equal((await h.decide()).targets[0].disposition, 'rejected');
    const human = (await h.decide(true)).targets[0];
    assert.equal(human.disposition, 'warned');
    assert.equal(human.ownerAttempt, true);
    assert.equal(human.automaticRetryAt, 301_000);
    assert.equal(
      (await h.snapshot()).candidates.find((cat) => cat.binding.catId === 'sol').availability,
      'unavailable',
    );
  });

  it('retains a manual pause even when automatic reasons fill the presentation budget', async () => {
    const h = harness();
    for (let index = 0; index < 40; index++) await h.negative(`old-${index}`, { reasonCode: `failure-${index}` });
    const automatic = await h.negative('template');
    await h.store.append({
      ...automatic,
      eventId: 'manual',
      commandId: 'manual',
      source: 'manual_cvo',
      reasonCode: 'paused',
      observedAt: 2_000,
    });
    const result = await h.decide(true);
    assert.equal(result.resolverState, 'fresh');
    assert.equal(result.targets[0].disposition, 'rejected');
  });

  it('recovers every matching old assertion despite coalesced display refs; all threads share the result', async () => {
    const h = harness();
    for (let index = 0; index < 145; index++)
      await h.negative(`old-${index}`, { state: 'degraded', source: 'health_probe' });
    const before = await h.decide(true);
    assert.equal(before.targets[0].reasons[0].sourceRefs.length, 32);
    h.time(11_000);
    await h.terminal(before);
    assert.equal((await h.decide()).targets[0].disposition, 'allowed');
    const closed = routingSignalClosures(h.events);
    assert.equal(closed.size, 145);
    const eventCount = h.events.length;
    await h.terminal(before);
    assert.equal(h.events.length, eventCount, 'terminal replay must not append another recovery');
  });

  it('keeps expired and recovered history bounded without failing open from schema overflow', async () => {
    const h = harness();
    for (let index = 0; index < 80; index++) await h.negative(`old-${index}`, { validUntil: 5_000 });
    const before = await h.decide(true);
    assert.equal(before.resolverState, 'fresh');
    assert.equal(before.targets[0].disposition, 'warned');
    assert.ok(before.targets[0].reasons.length <= 32);
    h.time(11_000);
    await h.terminal(before);
    assert.equal((await h.decide()).targets[0].disposition, 'allowed');
    assert.ok(h.events.length >= 80, 'history is retained');
  });

  it('uses actual failure time when an old failure is persisted after a successful probe', async () => {
    const h = harness();
    h.time(1_000);
    const oldAttempt = await h.decide(true);
    h.time(10_000);
    const successAttempt = await h.decide(true);
    h.time(11_000);
    await h.terminal(successAttempt);
    h.time(12_000);
    await h.terminal(oldAttempt, {
      observationId: 'old-failure',
      status: 'failed',
      failureClass: 'quota_exhausted',
      failureObservedAt: 2_000,
    });
    assert.equal((await h.decide()).targets[0].disposition, 'allowed');
    await h.terminal(oldAttempt, {
      observationId: 'new-failure',
      status: 'failed',
      failureClass: 'quota_exhausted',
      failureObservedAt: 11_500,
    });
    assert.equal((await h.decide()).targets[0].disposition, 'rejected', 'a newer real failure remains actionable');
  });

  it('does not recover later failures, other cats, provider-wide health, quota pools, or manual pauses', async () => {
    const h = harness();
    await h.negative('old');
    const before = await h.decide(true);
    await h.negative('newer', { observedAt: 10_001 });
    await h.negative('other', { subjectRef: { type: 'cat', catId: 'terra' } });
    await h.negative('provider', { subjectRef: { type: 'provider', providerId: 'openai' }, source: 'health_probe' });
    await h.negative('quota', { subjectRef: { type: 'quota_pool', poolId: 'pool' }, source: 'quota_probe' });
    const manual = await h.negative('template');
    await h.store.append({ ...manual, eventId: 'manual', commandId: 'manual', source: 'manual_cvo' });
    h.time(11_000);
    await h.terminal(before);
    const closed = routingSignalClosures(h.events);
    for (const event of h.events.filter((event) => event.eventType === 'asserted')) {
      if (
        event.reasonCode === 'quota_exhausted' &&
        (event.eventId === 'manual' || event.observedAt > 10_000 || event.subjectRef.catId !== 'sol')
      )
        assert.equal(closed.has(event.eventId), false);
    }
    assert.equal((await h.decide()).targets[0].disposition, 'rejected');
  });

  it('rejects forged probe scope and impossible observation times before writing any evidence', async () => {
    const h = harness();
    const decision = await h.decide(true);
    await assert.rejects(
      h.terminal(decision, { status: 'failed', failureClass: 'quota_exhausted', failureObservedAt: 9_999 }),
      /failed dispatch interval/,
    );
    await assert.rejects(
      h.service.recover({
        ownerId: 'owner',
        observationId: 'forged',
        subjectRef: { type: 'provider', providerId: 'openai' },
        source: 'dispatch_success',
        reasonCode: 'probe',
        observedAt: 12_000,
        probeStartedAt: 10_000,
        evidenceRef: 'probe:1',
        closesSignalIds: [],
        recoverableSources: ['provider_error'],
      }),
      /exact-cat/,
    );
    assert.equal(h.events.length, 0);
  });

  it('keeps chronological proof stable under concurrent completion order and manual retraction', async () => {
    const h = harness();
    const old = await h.negative('old', { observedAt: 5_000 });
    h.time(6_000);
    const older = await h.decide(true);
    h.time(10_000);
    const newer = await h.decide(true);
    h.time(11_000);
    await h.terminal(newer, { observationId: 'first-finish' });
    h.time(12_000);
    await h.terminal(older, { observationId: 'late-finish' });
    const proof = routingSignalClosures(h.events).get(old.eventId);
    assert.equal(proof.observedAt, 11_000);
    assert.equal(routingSignalClosures([...h.events].reverse()).get(old.eventId).eventId, proof.eventId);
    const { state: _state, probeStartedAt: _probe, ...base } = proof;
    await h.store.append({
      ...base,
      eventId: 'retracted',
      commandId: 'retracted',
      eventType: 'retracted',
      source: 'manual_cvo',
      observedAt: 5_500,
      closesSignalIds: [old.eventId],
    });
    assert.equal(routingSignalClosures(h.events).get(old.eventId).eventId, 'retracted');
  });
});
