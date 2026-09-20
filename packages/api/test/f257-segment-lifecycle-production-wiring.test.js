/**
 * F257 Gate 1 regression: the production composition owns the lifecycle
 * surface. Route tests that register individual plugins cannot prove this.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const openApps = [];
const ownerUserId = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner-1';

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function fakeTraceStore() {
  return {
    listTracedThreadIds: async () => [],
    queryWindow: async () => [],
    // The lifeline reads the caller's owner-indexed episode pool, not the
    // global thread registry, so the production surface needs this method.
    queryUnitWindow: async () => [],
    getReplaySnapshot: async () => null,
  };
}

function fakeOverrideStore() {
  return {
    listOverrides: async () => [],
    listEvents: async () => [],
    listVersions: async () => [],
  };
}

describe('F257 production segment lifecycle surface', () => {
  test('one production-owned registrar exposes lifecycle read, replay, evaluation, override and governance decision routes', async () => {
    const { registerSegmentLifecycleSurface } = await import('../dist/routes/segment-lifecycle-surface.js');
    const app = Fastify({ logger: false });
    openApps.push(app);
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = ownerUserId;
    });

    await registerSegmentLifecycleSurface(app, {
      traceStore: fakeTraceStore(),
      overrideStore: fakeOverrideStore(),
    });
    await app.ready();

    const lifeline = await app.inject({ method: 'GET', url: '/api/segment-lifeline/D11' });
    assert.equal(lifeline.statusCode, 200, lifeline.body);

    const replay = await app.inject({ method: 'GET', url: '/api/segment-lifeline/D11/replay' });
    assert.equal(replay.statusCode, 400, 'registered replay route must reject missing coordinates, not 404');

    const evaluation = await app.inject({ method: 'GET', url: '/api/segment-evaluation/D11' });
    assert.equal(evaluation.statusCode, 503, 'registered evaluation route must report unavailable runtime, not 404');

    const overrides = await app.inject({ method: 'GET', url: '/api/prompt-hooks/overrides' });
    assert.equal(overrides.statusCode, 200, overrides.body);
    assert.deepEqual(overrides.json(), { overrides: [] });

    const governanceDecision = await app.inject({
      method: 'POST',
      url: '/api/harness-governance-candidates/EC-missing/approve',
    });
    assert.equal(
      governanceDecision.statusCode,
      503,
      'registered governance route must report unavailable stores, not 404',
    );
  });

  test('governance routes expose approve/skip/reject and require a reject reason', async () => {
    const { registerSegmentLifecycleSurface } = await import('../dist/routes/segment-lifecycle-surface.js');
    const app = Fastify({ logger: false });
    openApps.push(app);
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = ownerUserId;
    });
    const calls = [];
    const governance = {
      async approveProposal(...args) {
        calls.push(['approve', ...args]);
        return { deduped: false };
      },
      async skipProposal(...args) {
        calls.push(['skip', ...args]);
        return { deduped: false };
      },
      async rejectProposal(...args) {
        calls.push(['reject', ...args]);
        return { deduped: false };
      },
    };
    await registerSegmentLifecycleSurface(app, {
      traceStore: fakeTraceStore(),
      overrideStore: fakeOverrideStore(),
      governance,
    });
    await app.ready();

    for (const action of ['approve', 'skip']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/harness-governance-candidates/HGP-1/${action}`,
        payload: { note: `${action} reason` },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    const missingReason = await app.inject({
      method: 'POST',
      url: '/api/harness-governance-candidates/HGP-1/reject',
      payload: {},
    });
    assert.equal(missingReason.statusCode, 400);
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/harness-governance-candidates/HGP-1/reject',
      payload: { note: 'draft is wrong' },
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.deepEqual(
      calls.map(([action, owner, proposal, actor, reason]) => [action, owner, proposal, actor, reason]),
      [
        ['approve', ownerUserId, 'HGP-1', ownerUserId, 'approve reason'],
        ['skip', ownerUserId, 'HGP-1', ownerUserId, 'skip reason'],
        ['reject', ownerUserId, 'HGP-1', ownerUserId, 'draft is wrong'],
      ],
    );
  });

  test('index.ts wires the canonical stores into the registrar and prompt content routes', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const surfaceSource = readFileSync(new URL('../src/routes/segment-lifecycle-surface.ts', import.meta.url), 'utf8');
    const lifelineSource = readFileSync(new URL('../src/routes/segment-lifeline.ts', import.meta.url), 'utf8');

    assert.match(source, /bootstrapHookOverrideStore\(redis\)/);
    assert.match(source, /registerSegmentLifecycleSurface\(app,\s*\{/);
    assert.match(source, /traceStore:\s*getTraceStore\(\)\s*\?\?\s*undefined/);
    assert.match(source, /^\s*guardRejectionLog,\s*$/m);
    assert.match(source, /^\s*overrideStore:\s*hookOverrideStore,\s*$/m);
    assert.match(source, /^\s*messageStore,\s*$/m);
    assert.match(source, /^\s*threadStore,\s*$/m);
    assert.match(source, /const runtime = getObjectiveEvaluationRuntime\(\)\s*\?\?\s*undefined/);
    assert.match(source, /^\s*runtime,\s*$/m);
    assert.match(source, /new HarnessGovernanceProposalStore\(redis\)/);
    assert.match(source, /CycleGovernanceCoordinator\(\{/);
    assert.match(source, /new HarnessGovernanceExecutor\(\{/);
    assert.match(source, /new HarnessUnitDirectoryWriter\(\{/);
    assert.match(source, /^\s*governance:\s*cycleGovernanceCoordinator,\s*$/m);
    assert.match(
      source,
      /F257:\s*bindLegacyApprovalProducer\(new F257ApprovalAdapter\(harnessGovernanceProposalStore\)\)/,
    );
    assert.doesNotMatch(
      source,
      /CandidateStore|GovernanceWorker|GovernanceDecisionGenerator|setPostCommitHook|reconcileLatestJudgments/,
      'production must expose only the CycleRecord governance path',
    );
    assert.match(source, /app\.register\(promptInjectionRoutes,\s*\{\s*overrideStore:\s*hookOverrideStore\s*\}\)/);
    assert.match(
      source,
      /app\.register\(promptInjectionManifestRoutes,\s*\{\s*overrideStore:\s*hookOverrideStore\s*\}\)/,
    );
    assert.doesNotMatch(
      lifelineSource,
      /SegmentJudgmentCache|segment-judgment-engine/,
      'production lifeline must not import either legacy judgment truth source',
    );
    assert.doesNotMatch(
      surfaceSource,
      /objectiveJudgmentToLifecycleProjection|judgments\.latest/,
      'production Console evaluation must read CycleRecord, not ObjectiveJudgment',
    );
  });

  test('serial and parallel production routing persist replay snapshots with trace summaries', () => {
    for (const route of ['route-serial.ts', 'route-parallel.ts']) {
      const source = readFileSync(
        new URL(`../src/domains/cats/services/agents/routing/${route}`, import.meta.url),
        'utf8',
      );
      assert.match(source, /persistPipelineTraceArtifacts\(\{/);
      assert.match(source, /messageStore:\s*deps\.messageStore/);
      assert.match(source, /messageAnchorId:/);
      assert.doesNotMatch(source, /\.persist\(pipelineResult\.summary, pipelineResult\.detail\)/);
    }
  });
});
