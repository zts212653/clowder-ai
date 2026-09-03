import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { RoutingPreflightService } = await import('../dist/domains/routing-context/RoutingPreflightService.js');

function candidate(catId, availability = 'available', reasons = [], profileState = 'applied') {
  return {
    binding: { v: 1, catId, providerId: `provider:${catId}`, provenQuotaPools: [] },
    profile:
      profileState === 'applied'
        ? {
            state: 'applied',
            revision: {
              v: 1,
              catId,
              modelId: `model:${catId}`,
              dossierRevision: `dossier:${catId}`,
              updatedAt: 1,
              relevantSignals: [],
              pendingProposalCount: 0,
            },
          }
        : { state: 'absent' },
    availability,
    freshness: availability === 'unknown' ? 'stale' : 'fresh',
    reasons,
    matchedPreferences: [],
    effect: availability === 'unavailable' ? 'blocked' : availability === 'available' ? 'eligible' : 'advisory',
  };
}

function freshResolution(candidates = [candidate('sol')]) {
  return {
    status: 'fresh',
    snapshot: {
      v: 1,
      ownerId: 'owner-1',
      observedAt: 10_000,
      catalogRevision: 'catalog:v1',
      candidates,
    },
    inputRevisionRef: 'sha256:fresh-input',
    sourceRefs: { signalEventIds: [], preferenceRevisionIds: [], dossierRevisions: [] },
  };
}

function input(targetCatIds = ['sol']) {
  return {
    ownerId: 'owner-1',
    observedAt: 10_000,
    catalogRevision: 'catalog:v1',
    candidates: targetCatIds.map((catId) => ({ v: 1, catId, providerId: `provider:${catId}`, provenQuotaPools: [] })),
    targetCatIds,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeClock(initial = 10_000) {
  let current = initial;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

describe('RoutingPreflightService', () => {
  it('maps fresh proof to per-target decisions and preference-ordered eligible alternatives', async () => {
    const unavailableReason = {
      code: 'routing_signal_unavailable',
      summary: 'provider is down',
      sourceRefs: ['signal:provider-down'],
    };
    const scarceReason = {
      code: 'routing_signal_scarce',
      summary: 'quota is scarce',
      sourceRefs: ['signal:quota-scarce'],
    };
    const resolver = {
      resolve: async () =>
        freshResolution([
          candidate('terra'),
          candidate('luna'),
          candidate('fable', 'scarce', [scarceReason]),
          candidate('sol', 'unavailable', [unavailableReason]),
        ]),
    };
    const service = new RoutingPreflightService({ resolver });
    const decision = await service.preflight(input(['luna', 'fable', 'sol', 'missing']));

    assert.equal(decision.resolverState, 'fresh');
    assert.equal(decision.snapshotRef, 'sha256:fresh-input');
    assert.deepEqual(
      decision.targets.map((target) => [target.targetCatId, target.disposition]),
      [
        ['luna', 'allowed'],
        ['fable', 'warned'],
        ['sol', 'rejected'],
        ['missing', 'warned'],
      ],
    );
    assert.deepEqual(
      decision.targets[2].alternatives.map((alternative) => alternative.catId),
      ['terra', 'luna'],
    );
    assert.deepEqual(decision.targets[2].reasons, [unavailableReason]);
    assert.equal(decision.targets[3].reasons[0].code, 'routing_target_not_in_catalog');
  });

  it('does not suggest a candidate without an applied capability profile as an alternative', async () => {
    const unavailableReason = {
      code: 'routing_signal_unavailable',
      summary: 'provider is down',
      sourceRefs: ['signal:provider-down'],
    };
    const service = new RoutingPreflightService({
      resolver: {
        resolve: async () =>
          freshResolution([
            candidate('sol', 'unavailable', [unavailableReason]),
            candidate('unprofiled', 'available', [], 'absent'),
            candidate('terra'),
          ]),
      },
    });

    const decision = await service.preflight(input(['sol', 'unprofiled']));
    assert.deepEqual(
      decision.targets[0].alternatives.map((alternative) => alternative.catId),
      ['terra'],
    );
    assert.equal(decision.targets[1].disposition, 'allowed');
  });

  it('turns typed resolver degradation into warned fail-open without changing target order', async () => {
    const audits = [];
    const service = new RoutingPreflightService({
      resolver: {
        resolve: async () => ({
          status: 'degraded',
          reason: 'built_in_profile_missing',
          affectedCatIds: ['sol'],
        }),
      },
      auditSink: { record: async (event) => audits.push(event) },
    });
    const decision = await service.preflight(input(['terra', 'sol']));

    assert.equal(decision.resolverState, 'degraded');
    assert.equal(decision.snapshotRef, undefined);
    assert.deepEqual(
      decision.targets.map((target) => [target.targetCatId, target.disposition]),
      [
        ['terra', 'warned'],
        ['sol', 'warned'],
      ],
    );
    assert.ok(decision.targets.every((target) => target.reasons[0].code === 'routing_context_unavailable'));
    assert.equal(audits.length, 1);
    assert.equal(audits[0].failureClass, 'resolver_degraded:built_in_profile_missing');
  });

  it('opens after consecutive failures, permits one half-open probe, and closes only on fresh success', async () => {
    const clock = fakeClock();
    const probe = deferred();
    let calls = 0;
    const resolver = {
      resolve: async () => {
        calls += 1;
        if (calls <= 5) throw new Error('redis offline');
        if (calls === 6) return probe.promise;
        return freshResolution();
      },
    };
    const service = new RoutingPreflightService({ resolver, clock });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const decision = await service.preflight(input());
      assert.equal(decision.targets[0].disposition, 'warned');
    }
    const openDecision = await service.preflight(input());
    assert.equal(openDecision.targets[0].disposition, 'warned');
    assert.equal(calls, 5);

    clock.advance(30_000);
    const halfOpenProbe = service.preflight(input());
    await Promise.resolve();
    const concurrent = await service.preflight(input());
    assert.equal(concurrent.targets[0].disposition, 'warned');
    assert.equal(calls, 6);

    probe.resolve(freshResolution());
    assert.equal((await halfOpenProbe).targets[0].disposition, 'allowed');
    assert.equal((await service.preflight(input())).targets[0].disposition, 'allowed');
    assert.equal(calls, 7);
  });

  it('reopens after a failed half-open probe and ignores a stale success from before the circuit opened', async () => {
    const clock = fakeClock();
    const stale = deferred();
    let calls = 0;
    const resolver = {
      resolve: async () => {
        calls += 1;
        if (calls === 1) return stale.promise;
        throw new Error('still offline');
      },
    };
    const service = new RoutingPreflightService({ resolver, clock, failureThreshold: 2 });

    const staleRequest = service.preflight(input());
    await Promise.resolve();
    await service.preflight(input());
    await service.preflight(input());
    assert.equal(calls, 3);
    stale.resolve(freshResolution());
    assert.equal((await staleRequest).targets[0].disposition, 'allowed');
    assert.equal((await service.preflight(input())).targets[0].disposition, 'warned');
    assert.equal(calls, 3);

    clock.advance(30_000);
    assert.equal((await service.preflight(input())).targets[0].disposition, 'warned');
    assert.equal(calls, 4);
    assert.equal((await service.preflight(input())).targets[0].disposition, 'warned');
    assert.equal(calls, 4);
  });

  it('classifies a read-budget timeout as warned degradation and dedupes owner audits for 30 seconds', async () => {
    const clock = fakeClock();
    const audits = [];
    const never = deferred();
    const service = new RoutingPreflightService({
      resolver: { resolve: async () => never.promise },
      clock,
      readBudgetMs: 5,
      auditSink: { record: async (event) => audits.push(event) },
    });

    assert.equal((await service.preflight(input())).targets[0].disposition, 'warned');
    assert.equal((await service.preflight(input())).targets[0].disposition, 'warned');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].failureClass, 'resolver_timeout');

    clock.advance(30_000);
    assert.equal((await service.preflight(input())).targets[0].disposition, 'warned');
    assert.equal(audits.length, 2);
  });

  it('does not let a stalled operational audit sink become a dispatch gate', async () => {
    const stalledAudit = deferred();
    const service = new RoutingPreflightService({
      resolver: { resolve: async () => Promise.reject(new Error('redis offline')) },
      auditSink: { record: async () => stalledAudit.promise },
    });

    const outcome = await Promise.race([
      service.preflight(input()).then((decision) => decision.targets[0].disposition),
      new Promise((resolve) => setTimeout(() => resolve('audit_blocked_dispatch'), 25)),
    ]);
    assert.equal(outcome, 'warned');
  });
});
