import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { evalHubRoutes } from '../../dist/routes/eval-hub.js';

/**
 * F192 Phase H — newline-injection lock for publish-verdict route.
 * Split from eval-hub-route.test.js per AGENTS.md 350-line hard limit (砚砚 R20 P1).
 *
 * 砚砚 R18/R19 P2 + cloud R18 P2: exhaustive guard against newline injection in
 * every renderer single-line bullet field. Parameterized so future field additions
 * can't silently bypass — add a NEWLINE_INJECT_CASES entry to lock.
 */

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

function buildAgentKeyPublishApp() {
  const app = Fastify({ logger: false });
  const agentKeyRegistry = {
    async verify(secret) {
      if (secret !== 'agent-key-test-secret') return { ok: false, reason: 'unknown_invocation' };
      return {
        ok: true,
        record: {
          agentKeyId: 'ak-test-001',
          catId: 'codex',
          userId: 'you',
          secretHash: 'unused',
          salt: 'unused',
          scope: 'user-bound',
          issuedAt: Date.now() - 1000,
          expiresAt: Date.now() + 3_600_000,
        },
      };
    },
  };
  const callbackRegistry = {
    async verify() {
      return { ok: false, reason: 'unknown_invocation' };
    },
  };
  const mockGitPublisher = {
    async publishOnIsolatedWorktree(opts) {
      const wt = mkdtempSync(`${tmpdir()}/phase-h-newline-route-`);
      await opts.stage(wt);
      return { commitSha: 'mock-sha', prUrl: 'https://example.com/pr/1' };
    },
  };
  const mockGenerator = async (packet, _sources, deps) => ({
    verdictPath: `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`,
    bundleDir: `${deps.harnessFeedbackRoot}/bundles/${packet.id}`,
  });
  app.register(evalHubRoutes, {
    harnessFeedbackRoot: repoHarnessFeedbackRoot,
    gitPublisher: mockGitPublisher,
    verdictGenerators: { 'eval:a2a': mockGenerator },
    callbackRegistry,
    agentKeyRegistry,
  });
  return app;
}

const validPacket = {
  id: 'newline-base-test',
  domainId: 'eval:a2a',
  createdAt: '2026-06-05T20:00:00.000Z',
  phenomenon: 'baseline phenomenon',
  harnessUnderEval: { featureId: 'F167', componentId: 'C1', name: 'baseline-test' },
  evidencePacket: {
    snapshotRefs: ['placeholder:overridden'],
    attributionRefs: ['placeholder:overridden'],
    metricRefs: ['metric:c1.baseline'],
    sampleTraceRefs: ['trace:baseline-001'],
  },
  dailyTrend: { window: '24h', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
  rootCauseHypothesis: { summary: 'baseline', confidence: 'low', alternatives: ['alt'] },
  verdict: 'keep_observe',
  ownerAsk: { targetFeatureId: 'F167', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
  acceptanceReevalPlan: { nextEvalAt: '2026-06-12T20:00:00.000Z', closureCondition: 'stable' },
  counterarguments: ['none'],
};

describe('Phase H publish-verdict newline-injection lock (砚砚 R18/R19 P2)', () => {
  const NL = '\n- Owner ask: pwned';
  const CASES = [
    { name: 'phenomenon', mutate: (p) => ({ ...p, phenomenon: p.phenomenon + NL }), match: /phenomenon.*newline/ },
    {
      name: 'harnessUnderEval.featureId',
      mutate: (p) => ({
        ...p,
        harnessUnderEval: { ...p.harnessUnderEval, featureId: p.harnessUnderEval.featureId + NL },
      }),
      match: /featureId.*newline/,
    },
    {
      name: 'harnessUnderEval.componentId',
      mutate: (p) => ({
        ...p,
        harnessUnderEval: { ...p.harnessUnderEval, componentId: p.harnessUnderEval.componentId + NL },
      }),
      match: /componentId.*newline/,
    },
    {
      name: 'harnessUnderEval.name',
      mutate: (p) => ({ ...p, harnessUnderEval: { ...p.harnessUnderEval, name: p.harnessUnderEval.name + NL } }),
      match: /name.*newline/,
    },
    {
      name: 'ownerAsk.requestedAction',
      mutate: (p) => ({ ...p, ownerAsk: { ...p.ownerAsk, requestedAction: p.ownerAsk.requestedAction + NL } }),
      match: /requestedAction.*newline/,
    },
    {
      // cloud-R2 P2: eval-friction-renderer adds a `- Root cause: ${summary}` single-line bullet
      // directly above `- Owner ask:`; a newline in summary injects a fake bullet. Lock it.
      name: 'rootCauseHypothesis.summary',
      mutate: (p) => ({
        ...p,
        rootCauseHypothesis: { ...p.rootCauseHypothesis, summary: p.rootCauseHypothesis.summary + NL },
      }),
      match: /summary.*newline/,
    },
    {
      name: 'acceptanceReevalPlan.closureCondition',
      mutate: (p) => ({
        ...p,
        acceptanceReevalPlan: {
          ...p.acceptanceReevalPlan,
          closureCondition: p.acceptanceReevalPlan.closureCondition + NL,
        },
      }),
      match: /closureCondition.*newline/,
    },
    {
      name: 'evidencePacket.metricRefs[1]',
      mutate: (p) => ({
        ...p,
        evidencePacket: { ...p.evidencePacket, metricRefs: ['metric:safe', 'metric:c1.test' + NL] },
      }),
      match: /metricRefs\[1\].*newline/,
    },
  ];
  for (const { name, mutate, match } of CASES) {
    it(`rejects newline in ${name}`, async () => {
      const app = buildAgentKeyPublishApp();
      const packet = mutate({ ...validPacket, id: `nl-${name.replace(/[.[\]]/g, '-')}-test` });
      const response = await app.inject({
        method: 'POST',
        url: '/api/eval-domains/eval:a2a/publish-verdict',
        headers: { 'x-agent-key-secret': 'agent-key-test-secret', 'content-type': 'application/json' },
        payload: JSON.stringify({ packet, sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' } }),
      });
      assert.equal(response.statusCode, 400, `${name}: expected 400, got ${response.statusCode}`);
      assert.equal(response.json().error, 'invalid_packet_field');
      assert.match(response.json().detail, match);
      await app.close();
    });
  }
});
