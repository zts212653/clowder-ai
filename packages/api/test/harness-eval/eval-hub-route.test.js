import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { evalHubRoutes } from '../../dist/routes/eval-hub.js';

/**
 * 砚砚 R17 P1: snapshots/attributions are gitignored, raw evidence lives in LIVE
 * harness-feedback root. Tests that exercise full publish pipeline need a writable
 * tmp root with seeded evidence files (NOT the real repo root).
 */
function makeLiveHarnessFeedbackWithEvidence(snapName, attrName) {
  const root = mkdtempSync(`${tmpdir()}/phase-h-route-live-`);
  mkdirSync(resolve(root, 'snapshots'), { recursive: true });
  mkdirSync(resolve(root, 'attributions'), { recursive: true });
  if (snapName) writeFileSync(resolve(root, 'snapshots', snapName), 'fake\n');
  if (attrName) writeFileSync(resolve(root, 'attributions', attrName), 'fake\n');
  // Copy eval-domains registry from real repo so domain lookup works
  const realDomainsDir = fileURLToPath(new URL('../../../../docs/harness-feedback/eval-domains', import.meta.url));
  const targetDomainsDir = resolve(root, 'eval-domains');
  mkdirSync(targetDomainsDir, { recursive: true });
  for (const f of readdirSync(realDomainsDir)) {
    if (f.endsWith('.yaml') || f.endsWith('.yml')) {
      copyFileSync(resolve(realDomainsDir, f), resolve(targetDomainsDir, f));
    }
  }
  return root;
}

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

async function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const userId = request.headers['x-test-user-id'];
    if (typeof userId === 'string') {
      request.sessionUserId = userId;
    }
  });
  await app.register(evalHubRoutes, { harnessFeedbackRoot: repoHarnessFeedbackRoot });
  return app;
}

describe('Eval Hub API route', () => {
  it('requires an authenticated session', async () => {
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/api/eval-hub/summary' });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'Session required' });
    await app.close();
  });

  it('returns the Eval Hub summary for authenticated users', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/eval-hub/summary',
      headers: { 'x-test-user-id': 'you' },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    // PR-3 (F192 H 收尾): #2114 merge added a 2nd verdict to main since this test
    // was authored. Assert >= 1 (count-tolerant) + verify the original fixture
    // verdict still appears by ID — not by index (more verdicts WILL accumulate
    // as scheduled evals publish more artifacts).
    assert.ok(body.counts.total >= 1, `expected at least 1 verdict, got ${body.counts.total}`);
    const originalVerdict = body.items.find((v) => v.id === '2026-05-23-eval-a2a-live-verdict');
    assert.ok(originalVerdict, 'fixture verdict 2026-05-23-eval-a2a-live-verdict must remain in summary');
    assert.equal(originalVerdict.systemWorkspace.kind, 'eval_domain');
    assert.equal(originalVerdict.evidence.snapshotRefs[0], 'snapshot:bundle/2026-05-23-eval-a2a-live-verdict/snapshot');
    await app.close();
  });

  // 砚砚 R10 P1: lock R9 fix in. Without these tests, removing agentKeyRegistry
  // wiring or principal.kind==='agent_key' guard would not break the build —
  // exactly the failure mode R9 caught manually. These regression-test that
  // (a) agent-key header reaches handler with server-trusted catId, AND
  // (b) removing wiring causes 401 (negative direction).
  describe('Phase H AC-H4: agent-key publish path (砚砚 R10 P1)', () => {
    function buildAgentKeyPublishApp({ withAgentKeyRegistry = true, generatorSpy = null, liveHarnessRoot } = {}) {
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
          // 砚砚 R17 P1: empty isolated worktree; stage copies LIVE evidence in.
          const wt = mkdtempSync(`${tmpdir()}/phase-h-r10-route-`);
          await opts.stage(wt);
          return { commitSha: 'mock-sha', prUrl: 'https://example.com/pr/1' };
        },
      };
      const mockGenerator = async (packet, sources, deps) => {
        if (generatorSpy) generatorSpy(packet, sources, deps);
        return {
          verdictPath: `${deps.harnessFeedbackRoot}/verdicts/${packet.id}.md`,
          bundleDir: `${deps.harnessFeedbackRoot}/bundles/${packet.id}`,
        };
      };
      app.register(evalHubRoutes, {
        harnessFeedbackRoot: liveHarnessRoot ?? repoHarnessFeedbackRoot,
        gitPublisher: mockGitPublisher,
        verdictGenerators: { 'eval:a2a': mockGenerator },
        callbackRegistry,
        ...(withAgentKeyRegistry ? { agentKeyRegistry } : {}),
      });
      return app;
    }

    const validPacket = {
      id: 'r10-route-test-2026-06-05',
      domainId: 'eval:a2a',
      createdAt: '2026-06-05T20:00:00.000Z',
      phenomenon: 'route-level agent-key publish test',
      harnessUnderEval: { featureId: 'F167', componentId: 'C1', name: 'r10-test' },
      evidencePacket: {
        // 砚砚 R11 P1: AC-H1 requires all 4 ref types non-empty. snapshot/attribution
        // are bundle-overridden, but metric/trace come from cat's submitted packet.
        snapshotRefs: ['placeholder:overridden'],
        attributionRefs: ['placeholder:overridden'],
        metricRefs: ['metric:c1.r10.test'],
        sampleTraceRefs: ['trace:r10-route-001'],
      },
      dailyTrend: { window: '24h', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
      rootCauseHypothesis: { summary: 'r10', confidence: 'low', alternatives: ['alt'] },
      verdict: 'keep_observe',
      ownerAsk: { targetFeatureId: 'F167', targetOwnerCatId: 'opus-47', requestedAction: 'observe' },
      acceptanceReevalPlan: { nextEvalAt: '2026-06-12T20:00:00.000Z', closureCondition: 'stable' },
      counterarguments: ['none'],
    };

    it('agent-key header → handler receives server-trusted catId (R9 wiring locked)', async () => {
      const calls = [];
      // 砚砚 R17 P1: seed LIVE evidence in tmp root (real repo's snapshots/ gitignored)
      const liveHarnessRoot = makeLiveHarnessFeedbackWithEvidence('snap.yaml', 'attr.yaml');
      const app = buildAgentKeyPublishApp({
        generatorSpy: (packet) => calls.push({ packetId: packet.id }),
        liveHarnessRoot,
      });

      // 砚砚 R10: this body has NO catId field; if route accidentally trusts body
      // catId in the future, this test still passes because we assert via handler
      // call (server-derived catId comes from agent-key principal record).
      const response = await app.inject({
        method: 'POST',
        url: '/api/eval-domains/eval:a2a/publish-verdict',
        headers: { 'x-agent-key-secret': 'agent-key-test-secret', 'content-type': 'application/json' },
        payload: JSON.stringify({
          packet: validPacket,
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        }),
      });

      // Generator not invoked (stage skipped in mock), so we just verify route
      // got past auth + cat allowlist (registry codex == derivedPrincipal.catId).
      // Mock publisher returns success → 200.
      assert.equal(response.statusCode, 200, `expected 200, got ${response.statusCode}: ${response.body}`);
      const body = response.json();
      assert.equal(body.commitSha, 'mock-sha');
      assert.equal(body.prUrl, 'https://example.com/pr/1');
      await app.close();
    });

    it('without agentKeyRegistry wiring → 401 (regression for R9 composition gap)', async () => {
      const app = buildAgentKeyPublishApp({ withAgentKeyRegistry: false });

      const response = await app.inject({
        method: 'POST',
        url: '/api/eval-domains/eval:a2a/publish-verdict',
        headers: { 'x-agent-key-secret': 'agent-key-test-secret', 'content-type': 'application/json' },
        payload: JSON.stringify({
          packet: validPacket,
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        }),
      });

      // Without agent-key registry wired, header is ignored → callbackPrincipal
      // never decorated → requireCallbackPrincipal sends 401 unknown_invocation.
      assert.equal(response.statusCode, 401, `expected 401, got ${response.statusCode}: ${response.body}`);
      await app.close();
    });

    // 砚砚 R11 P1: submittedPacket path must enforce evidencePacket completeness
    // (snapshot/attribution/metric/trace all non-empty). schema only checks "array",
    // assertCanCrossThreadHandoff checks "non-empty".
    it('rejects submittedPacket with empty metricRefs/sampleTraceRefs (handoff_incomplete 400)', async () => {
      const app = buildAgentKeyPublishApp();
      const incompletePacket = {
        ...validPacket,
        id: 'r11-incomplete-2026-06-05',
        evidencePacket: {
          snapshotRefs: ['placeholder:overridden'],
          attributionRefs: ['placeholder:overridden'],
          metricRefs: [], // ← incomplete: AC-H1 violation
          sampleTraceRefs: [],
        },
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/eval-domains/eval:a2a/publish-verdict',
        headers: { 'x-agent-key-secret': 'agent-key-test-secret', 'content-type': 'application/json' },
        payload: JSON.stringify({
          packet: incompletePacket,
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        }),
      });

      assert.equal(response.statusCode, 400, `expected 400, got ${response.statusCode}: ${response.body}`);
      const body = response.json();
      assert.equal(body.error, 'handoff_incomplete');
      assert.match(body.detail, /metric|trace/);
      await app.close();
    });

    // 砚砚 R18/R19 P2 newline-injection lock extracted to eval-hub-route-newline.test.js
    // per AGENTS.md 350-line limit (砚砚 R20 P1)

    it('rejects wrong cat under agent-key (registry codex vs principal opus-47 → 403)', async () => {
      // Override mock to return a different catId
      const app = Fastify({ logger: false });
      const agentKeyRegistry = {
        async verify() {
          return {
            ok: true,
            record: {
              agentKeyId: 'ak-test-002',
              catId: 'opus-47',
              userId: 'you',
              secretHash: 'u',
              salt: 'u',
              scope: 'user-bound',
              issuedAt: Date.now() - 1000,
              expiresAt: Date.now() + 3_600_000,
            },
          };
        },
      };
      app.register(evalHubRoutes, {
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        gitPublisher: {
          async publishOnIsolatedWorktree(opts) {
            await opts.stage('/tmp/wrong-cat-test');
            return { commitSha: 'x', prUrl: 'x' };
          },
        },
        verdictGenerators: { 'eval:a2a': async () => ({ verdictPath: '/x', bundleDir: '/x' }) },
        callbackRegistry: {
          async verify() {
            return { ok: false, reason: 'unknown_invocation' };
          },
        },
        agentKeyRegistry,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/eval-domains/eval:a2a/publish-verdict',
        headers: { 'x-agent-key-secret': 'agent-key-test-secret', 'content-type': 'application/json' },
        payload: JSON.stringify({
          packet: validPacket,
          sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
        }),
      });

      assert.equal(response.statusCode, 403, `expected 403, got ${response.statusCode}: ${response.body}`);
      const body = response.json();
      assert.equal(body.error, 'not_allowed');
      assert.match(body.detail, /opus-47/);
      await app.close();
    });
  });
});
