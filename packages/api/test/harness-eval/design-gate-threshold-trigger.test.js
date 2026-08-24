import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  loadDesignGateThresholdDomain,
  observeDesignGateThresholdTrigger,
  startDesignGateThresholdObserver,
} from '../../dist/infrastructure/harness-eval/design-gate/design-gate-threshold-trigger.js';
import { parseEvalDomainRegistryEntry } from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';

const domain = parseEvalDomainRegistryEntry({
  domainId: 'eval:design-gate',
  displayName: 'Design Gate Integrity Eval',
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
  sla: { acknowledgeHours: 48, reevalWithinHours: 336 },
});

class MemoryStore {
  receipts = new Map();

  async claim(input) {
    const key = `${input.kind}:${input.domainId}:${input.receiptId}`;
    const current = this.receipts.get(key);
    if (current?.status === 'dispatched') return { outcome: 'deduped' };
    this.receipts.set(key, { status: 'claimed', token: input.token });
    return { outcome: 'claimed' };
  }

  async complete(input) {
    const key = `${input.kind}:${input.domainId}:${input.receiptId}`;
    const current = this.receipts.get(key);
    if (current?.status !== 'claimed' || current.token !== input.token) return false;
    this.receipts.set(key, { status: 'dispatched' });
    return true;
  }

  async release(input) {
    const key = `${input.kind}:${input.domainId}:${input.receiptId}`;
    if (this.receipts.get(key)?.token === input.token) this.receipts.delete(key);
  }
}

function transition(previousEligibleEpisodes, currentEligibleEpisodes, overrides = {}) {
  return {
    eventId: `design-gate-source-map:map-${currentEligibleEpisodes}`,
    sourceMapId: `map-${currentEligibleEpisodes}`,
    sourceMapRef: `docs/harness-feedback/design-gate/source-maps/map-${currentEligibleEpisodes}.yaml`,
    previousEligibleEpisodes,
    currentEligibleEpisodes,
    sourceValid: true,
    ...overrides,
  };
}

function setup(value, overrides = {}) {
  const store = overrides.store ?? new MemoryStore();
  return {
    store,
    deliver: mock.fn(async () => 'message-design-gate'),
    invokeTrigger: { trigger: mock.fn(async () => 'dispatched') },
    input: {
      provider: { resolveLatestTransition: async () => value },
      domain,
      store,
      nowMs: Date.parse('2026-08-24T08:00:00Z'),
      defaultUserId: 'owner-user',
      wiredPublishDomains: new Set(['eval:design-gate']),
      ...overrides,
    },
  };
}

describe('F303 design-gate threshold trigger', () => {
  it('does not admit a sunset domain to threshold observer wiring', async () => {
    const harnessFeedbackRoot = await mkdtemp(join(tmpdir(), 'f192-disabled-threshold-domain-'));
    try {
      const evalDomainsRoot = join(harnessFeedbackRoot, 'eval-domains');
      await mkdir(evalDomainsRoot);
      await writeFile(
        join(evalDomainsRoot, 'eval-design-gate.yaml'),
        stringifyYaml({ ...domain, enabled: false }),
        'utf8',
      );

      assert.equal(loadDesignGateThresholdDomain(harnessFeedbackRoot), undefined);
    } finally {
      await rm(harnessFeedbackRoot, { recursive: true, force: true });
    }
  });

  it('dispatches the 1→20 threshold crossing once and dedupes replay', async () => {
    const state = setup(transition(1, 20));
    state.input.deliver = state.deliver;
    state.input.invokeTrigger = state.invokeTrigger;

    const first = await observeDesignGateThresholdTrigger(state.input);
    const replay = await observeDesignGateThresholdTrigger(state.input);

    assert.equal(first.outcome, 'dispatched');
    assert.equal(replay.outcome, 'deduped');
    assert.equal(state.deliver.mock.callCount(), 1);
    assert.equal(state.invokeTrigger.trigger.mock.callCount(), 1);
    assert.match(state.deliver.mock.calls[0].arguments[0].content, /Trigger channel: threshold_event/);
  });

  it('records 20→21 as non-crossing without invoking', async () => {
    const state = setup(transition(20, 21));
    state.input.deliver = state.deliver;
    state.input.invokeTrigger = state.invokeTrigger;

    const result = await observeDesignGateThresholdTrigger(state.input);

    assert.equal(result.outcome, 'not_crossing');
    assert.equal(state.deliver.mock.callCount(), 0);
  });

  it('fails closed for invalid or missing source truth', async () => {
    const invalid = setup(transition(19, 20, { sourceValid: false }));
    invalid.input.deliver = invalid.deliver;
    assert.equal((await observeDesignGateThresholdTrigger(invalid.input)).outcome, 'invalid_source');
    assert.equal(invalid.deliver.mock.callCount(), 0);

    const missing = setup(transition(19, 20));
    missing.input.provider = { resolveLatestTransition: async () => Promise.reject(new Error('missing source')) };
    missing.input.deliver = missing.deliver;
    assert.equal((await observeDesignGateThresholdTrigger(missing.input)).outcome, 'invalid_source');
    assert.equal(missing.deliver.mock.callCount(), 0);
  });

  it('does not invoke when the durable event receipt is unavailable', async () => {
    const state = setup(transition(19, 20), {
      store: { claim: async () => Promise.reject(new Error('redis unavailable')) },
    });
    state.input.deliver = state.deliver;
    state.input.invokeTrigger = state.invokeTrigger;

    const result = await observeDesignGateThresholdTrigger(state.input);

    assert.equal(result.outcome, 'unavailable');
    assert.equal(state.deliver.mock.callCount(), 0);
  });

  it('replays once at startup and observes later YAML source-map revisions without overlap', async () => {
    let listener;
    let closed = false;
    let observations = 0;
    const handle = startDesignGateThresholdObserver({
      sourceMapRoot: '/isolated/design-gate/source-maps',
      observe: async () => {
        observations += 1;
        return { outcome: 'not_crossing' };
      },
      watchFactory: (_root, _options, callback) => {
        listener = callback;
        return {
          close: () => {
            closed = true;
          },
          on: () => {},
        };
      },
      logger: { info: () => {}, warn: () => {} },
    });

    await handle.waitForIdle();
    assert.equal(observations, 1, 'startup replay must observe current durable source truth');
    listener('change', 'README.md');
    await handle.waitForIdle();
    assert.equal(observations, 1, 'unrelated files must not trigger an eval observation');
    listener('rename', 'f303-observation-twenty.yaml');
    listener('change', 'f303-observation-twenty.yaml');
    await handle.waitForIdle();
    assert.equal(observations, 2, 'bursty notifications must coalesce into one serialized observation');

    handle.close();
    assert.equal(closed, true);
  });
});
