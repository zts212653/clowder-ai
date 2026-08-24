import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { parseEvalDomainRegistryEntry } from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';
import {
  deriveEvalDomainTriggerWindow,
  dispatchEvalDomainTrigger,
} from '../../dist/infrastructure/harness-eval/domain/eval-domain-trigger-dispatch.js';

const thresholdDomain = parseEvalDomainRegistryEntry({
  domainId: 'eval:design-gate',
  displayName: 'Design Gate',
  systemThreadId: 'thread_eval_design_gate',
  evalCat: { catId: 'codex-sol', handle: '@codex-sol', model: 'gpt-5.6-sol' },
  frequency: 'weekly',
  triggerPolicy: {
    mode: 'threshold_or_time',
    maxDetectionDelayHours: 168,
    cooldownHours: 24,
    eventSource: 'design-gate-source-map',
    threshold: { counter: 'eligibleEpisodes', crossingAt: 20 },
  },
  sourceAdapter: 'f303-design-gate-episode',
  sourceRefsKind: 'design-gate-episode-source-map',
  threadPolicy: { role: 'working-home', stateSot: 'registry', allowedContent: ['longitudinal-analysis'] },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F303', ownerCatId: 'codex-sol', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 24, reevalWithinHours: 168 },
});

const timeOnlyDomain = parseEvalDomainRegistryEntry({ ...thresholdDomain, triggerPolicy: undefined });
const invocation = {
  domainId: thresholdDomain.domainId,
  targetThreadId: thresholdDomain.systemThreadId,
  evalCat: thresholdDomain.evalCat,
  instructions: 'Reconstruct evidence and evaluate the domain contract.',
  context: { domainId: thresholdDomain.domainId },
};

class MemoryTriggerStore {
  receipts = new Map();
  cooldowns = new Map();

  async claim(input) {
    const key = `${input.kind}:${input.domainId}:${input.receiptId}`;
    const current = this.receipts.get(key);
    if (current?.status === 'dispatched') return { outcome: 'deduped' };
    if (current?.status === 'claimed' && current.leaseUntilMs > input.nowMs) return { outcome: 'overlap' };
    if (input.kind === 'window' && (this.cooldowns.get(input.domainId) ?? 0) > input.nowMs) {
      this.receipts.set(key, { status: 'dispatched', channel: 'cooldown', dispatchedAtMs: input.nowMs });
      return { outcome: 'cooldown' };
    }
    this.receipts.set(key, { status: 'claimed', token: input.token, leaseUntilMs: input.nowMs + input.leaseMs });
    return { outcome: 'claimed' };
  }

  async complete(input) {
    const key = `${input.kind}:${input.domainId}:${input.receiptId}`;
    const current = this.receipts.get(key);
    if (current?.status !== 'claimed' || current.token !== input.token) return false;
    this.receipts.set(key, { status: 'dispatched', channel: input.channel, dispatchedAtMs: input.nowMs });
    if (input.kind === 'window' && input.cooldownUntilMs) {
      this.cooldowns.set(input.domainId, input.cooldownUntilMs);
    }
    return true;
  }

  async release(input) {
    const key = `${input.kind}:${input.domainId}:${input.receiptId}`;
    const current = this.receipts.get(key);
    if (current?.status === 'claimed' && current.token === input.token) this.receipts.delete(key);
  }
}

function event(eventId = 'source-map-20') {
  return {
    eventId,
    eventSource: 'design-gate-source-map',
    counter: 'eligibleEpisodes',
    previousValue: 19,
    currentValue: 20,
  };
}

function deps(store, nowMs, overrides = {}) {
  return {
    store,
    nowMs,
    tokenFactory: (() => {
      let token = 0;
      return () => `token-${++token}`;
    })(),
    deliver: mock.fn(async () => 'message-1'),
    invokeTrigger: { trigger: mock.fn(async () => 'dispatched') },
    defaultUserId: 'owner-user',
    ...overrides,
  };
}

describe('eval domain shared trigger dispatcher', () => {
  it('derives one cadence-aligned UTC window for event and cron channels', () => {
    const beforeCron = Date.parse('2026-08-30T02:59:59Z');
    const atCron = Date.parse('2026-08-30T03:00:00Z');
    assert.equal(
      deriveEvalDomainTriggerWindow(thresholdDomain.frequency, beforeCron).windowKey,
      'weekly:2026-08-23T03:00:00.000Z',
    );
    assert.equal(
      deriveEvalDomainTriggerWindow(thresholdDomain.frequency, atCron).windowKey,
      'weekly:2026-08-30T03:00:00.000Z',
    );
  });

  it('accepts at most one invocation when event and cron race in the same window', async () => {
    const store = new MemoryTriggerStore();
    const nowMs = Date.parse('2026-08-24T08:00:00Z');
    const shared = deps(store, nowMs);

    const outcomes = await Promise.all([
      dispatchEvalDomainTrigger({
        domain: thresholdDomain,
        invocation,
        channel: 'threshold_event',
        event: event(),
        triggerReason: 'Threshold eval: eval:design-gate',
        ...shared,
      }),
      dispatchEvalDomainTrigger({
        domain: thresholdDomain,
        invocation,
        channel: 'time',
        triggerReason: 'Weekly eval: eval:design-gate',
        ...shared,
      }),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.outcome === 'dispatched').length, 1);
    assert.equal(shared.deliver.mock.callCount(), 1);
  });

  it('releases failed delivery ownership so replay reuses the stable message key', async () => {
    const store = new MemoryTriggerStore();
    const nowMs = Date.parse('2026-08-24T08:00:00Z');
    let firstAttempt = true;
    const trigger = mock.fn(async () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('transient');
      }
      return 'enqueued';
    });
    const shared = deps(store, nowMs, { invokeTrigger: { trigger } });
    const input = {
      domain: thresholdDomain,
      invocation,
      channel: 'threshold_event',
      event: event(),
      triggerReason: 'Threshold eval: eval:design-gate',
      ...shared,
    };

    assert.equal((await dispatchEvalDomainTrigger(input)).outcome, 'trigger_failed');
    assert.equal((await dispatchEvalDomainTrigger(input)).outcome, 'dispatched');
    assert.equal(
      shared.deliver.mock.calls[0].arguments[0].idempotencyKey,
      shared.deliver.mock.calls[1].arguments[0].idempotencyKey,
    );
  });

  it('reclaims an expired window lease and applies cooldown across a near-boundary window', async () => {
    const store = new MemoryTriggerStore();
    const eventAt = Date.parse('2026-08-30T02:00:00Z');
    const firstWindow = deriveEvalDomainTriggerWindow(thresholdDomain.frequency, eventAt);
    store.receipts.set(`window:${thresholdDomain.domainId}:${firstWindow.windowKey}`, {
      status: 'claimed',
      token: 'crashed-owner',
      leaseUntilMs: eventAt - 1,
    });

    const first = deps(store, eventAt);
    assert.equal(
      (
        await dispatchEvalDomainTrigger({
          domain: thresholdDomain,
          invocation,
          channel: 'threshold_event',
          event: event(),
          triggerReason: 'Threshold eval',
          ...first,
        })
      ).outcome,
      'dispatched',
    );

    const cron = deps(store, Date.parse('2026-08-30T03:00:00Z'));
    assert.equal(
      (
        await dispatchEvalDomainTrigger({
          domain: thresholdDomain,
          invocation,
          channel: 'time',
          triggerReason: 'Weekly eval',
          ...cron,
        })
      ).outcome,
      'cooldown',
    );
    assert.equal(cron.deliver.mock.callCount(), 0);
    assert.deepEqual(
      await store.claim({
        kind: 'window',
        domainId: thresholdDomain.domainId,
        receiptId: deriveEvalDomainTriggerWindow(thresholdDomain.frequency, Date.parse('2026-08-30T03:00:00Z'))
          .windowKey,
        token: 'late-retry',
        nowMs: Date.parse('2026-08-31T04:00:00Z'),
        leaseMs: 1_000,
      }),
      { outcome: 'deduped' },
    );
  });

  it('dedupes stale event replay and records non-crossing observations without invoking', async () => {
    const store = new MemoryTriggerStore();
    const nowMs = Date.parse('2026-08-24T08:00:00Z');
    const shared = deps(store, nowMs);
    const nonCrossing = event('source-map-21');
    nonCrossing.previousValue = 20;
    nonCrossing.currentValue = 21;

    const first = await dispatchEvalDomainTrigger({
      domain: thresholdDomain,
      invocation,
      channel: 'threshold_event',
      event: nonCrossing,
      triggerReason: 'Threshold eval',
      ...shared,
    });
    const replay = await dispatchEvalDomainTrigger({
      domain: thresholdDomain,
      invocation,
      channel: 'threshold_event',
      event: nonCrossing,
      triggerReason: 'Threshold eval',
      ...shared,
    });

    assert.equal(first.outcome, 'not_crossing');
    assert.equal(replay.outcome, 'deduped');
    assert.equal(shared.deliver.mock.callCount(), 0);
  });

  it('rejects threshold events for time_only domains', async () => {
    const shared = deps(new MemoryTriggerStore(), Date.parse('2026-08-24T08:00:00Z'));
    const result = await dispatchEvalDomainTrigger({
      domain: timeOnlyDomain,
      invocation,
      channel: 'threshold_event',
      event: event(),
      triggerReason: 'Threshold eval',
      ...shared,
    });
    assert.equal(result.outcome, 'rejected_policy');
    assert.equal(shared.deliver.mock.callCount(), 0);
  });

  it('fails the event lane closed when receipts are unavailable while keeping time fallback live', async () => {
    const unavailableStore = { claim: async () => Promise.reject(new Error('redis unavailable')) };
    const eventDeps = deps(unavailableStore, Date.parse('2026-08-24T08:00:00Z'));
    const eventResult = await dispatchEvalDomainTrigger({
      domain: thresholdDomain,
      invocation,
      channel: 'threshold_event',
      event: event(),
      triggerReason: 'Threshold eval',
      ...eventDeps,
    });
    assert.equal(eventResult.outcome, 'unavailable');
    assert.equal(eventDeps.deliver.mock.callCount(), 0);

    const timeDeps = deps(unavailableStore, Date.parse('2026-08-24T08:00:00Z'));
    const timeResult = await dispatchEvalDomainTrigger({
      domain: thresholdDomain,
      invocation,
      channel: 'time',
      triggerReason: 'Weekly eval',
      ...timeDeps,
    });
    assert.equal(timeResult.outcome, 'dispatched');
    assert.equal(timeDeps.deliver.mock.callCount(), 1);
  });

  it('grounds trigger metadata without claiming maturity or actionability', async () => {
    const shared = deps(new MemoryTriggerStore(), Date.parse('2026-08-24T08:00:00Z'));
    await dispatchEvalDomainTrigger({
      domain: thresholdDomain,
      invocation,
      channel: 'time',
      triggerReason: 'Weekly eval',
      ...shared,
    });
    const delivered = shared.deliver.mock.calls[0].arguments[0];
    assert.match(delivered.content, /Trigger channel: time/);
    assert.match(delivered.content, /Invocation is only a wake attempt/);
    assert.match(delivered.content, /does not establish maturity, validity, or actionability/);
  });
});
