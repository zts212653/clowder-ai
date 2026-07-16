import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { parseEvalDomainRegistryFile } from '../../dist/infrastructure/harness-eval/domain/eval-domain-registry.js';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
import {
  generateSessionRecoveryLiveVerdict,
  gradeSessionRecoveryTrial,
  SessionRecoveryTrialProvider,
} from '../../dist/infrastructure/harness-eval/session-recovery/index.js';

const FIXTURE_NAMES = ['clean', 'stale', 'missing-target'];
const registrySource = readFileSync(
  new URL('../../../../docs/harness-feedback/eval-domains/eval-session-recovery.yaml', import.meta.url),
  'utf8',
);
const domain = parseEvalDomainRegistryFile(parse(registrySource));

function loadFixture(name) {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../docs/harness-feedback/fixtures/session-recovery/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}

function createProvider(fixture, reads) {
  return new SessionRecoveryTrialProvider({
    sessionStore: {
      async scanAll(window) {
        reads.push({ kind: 'session-scan', window });
        return fixture.sessions;
      },
    },
    transcriptReader: {
      async readEvents(sessionId, threadId, catId, cursor, limit = 100) {
        reads.push({ kind: 'transcript-read', sessionId, threadId, catId, cursor, limit });
        const events = fixture.transcripts[sessionId] ?? [];
        const start = cursor?.eventNo ?? 0;
        const page = events.filter((event) => event.eventNo >= start).slice(0, limit);
        const last = page.at(-1);
        return {
          events: page,
          total: events.length,
          ...(last && last.eventNo + 1 < events.length ? { nextCursor: { eventNo: last.eventNo + 1 } } : {}),
        };
      },
    },
  });
}

function packet(fixture, trial) {
  const hasFailure = fixture.expected.structural === 'fail' || fixture.expected.semantic === 'fail';
  return {
    id: `session-recovery-fixture-${fixture.id}`,
    domainId: 'eval:session-recovery',
    createdAt: '2026-07-16T12:00:00.000Z',
    phenomenon: `Isolated ${fixture.id} session recovery acceptance case.`,
    harnessUnderEval: {
      featureId: 'F192',
      componentId: 'session-recovery',
      name: 'session recovery correctness',
    },
    evidencePacket: {
      snapshotRefs: ['placeholder:snapshot'],
      attributionRefs: ['placeholder:attribution'],
      metricRefs: ['metric:session-recovery/assessed_total'],
      sampleTraceRefs: [trial.source.evidenceRef],
    },
    dailyTrend: {
      window: 'fixture',
      current: { assessed_total: 1 },
      baseline: { assessed_total: 0 },
      threshold: { failure_count: 0 },
      direction: hasFailure ? 'regressed' : 'unknown',
    },
    rootCauseHypothesis: {
      summary: hasFailure ? 'The fixture contains a recovery failure.' : 'The fixture contains no recovery failure.',
      confidence: 'high',
      alternatives: ['This is a deterministic synthetic acceptance fixture, not a population estimate.'],
    },
    verdict: hasFailure ? 'fix' : 'keep_observe',
    ownerAsk: {
      targetFeatureId: 'F192',
      targetOwnerCatId: 'cat-vjdun65e',
      requestedAction: hasFailure
        ? 'Inspect the referenced transition anchors.'
        : 'Keep observing live bounded windows.',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-07-23T12:00:00.000Z',
      closureCondition: 'The corresponding fixture remains stable and live windows contain no unexplained failures.',
    },
    counterarguments: ['Synthetic fixtures prove contract behavior but do not establish live incidence rates.'],
  };
}

function seedIsolatedHarnessRoot() {
  const root = mkdtempSync(join(tmpdir(), 'session-recovery-fixture-'));
  const harnessFeedbackRoot = join(root, 'docs', 'harness-feedback');
  mkdirSync(join(harnessFeedbackRoot, 'eval-domains'), { recursive: true });
  writeFileSync(join(harnessFeedbackRoot, 'eval-domains', 'eval-session-recovery.yaml'), registrySource);
  return harnessFeedbackRoot;
}

describe('session recovery isolated acceptance fixtures', () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}: provider → grader → sanitized bundle → Eval Hub without network or thread writes`, async (t) => {
      const connectMock = t.mock.method(Socket.prototype, 'connect', () => {
        throw new Error('fixture acceptance attempted a network connection');
      });
      const fixture = loadFixture(name);
      const reads = [];
      const provider = createProvider(fixture, reads);

      const previewTrials = await provider.resolve(fixture.selector, { ownerUserId: fixture.ownerUserId });
      assert.equal(previewTrials.length, 1);
      assert.equal(previewTrials[0].assessment, undefined, 'preview must not invent semantic labels');

      const trials = await provider.resolve(
        { ...fixture.selector, assessments: [fixture.assessment] },
        { ownerUserId: fixture.ownerUserId },
      );
      const trial = trials[0];
      const grade = gradeSessionRecoveryTrial(trial);
      assert.equal(trial.lineage, fixture.expected.lineage);
      assert.equal(trial.transitionIntegrity, fixture.expected.transitionIntegrity);
      assert.equal(trial.delivery, fixture.expected.delivery);
      assert.equal(grade.structural, fixture.expected.structural);
      assert.equal(grade.semantic, fixture.expected.semantic);
      assert.equal(grade.stateReconstruction, fixture.expected.stateReconstruction);
      assert.equal(grade.firstMeaningfulAction, fixture.expected.firstMeaningfulAction);
      assert.equal(grade.outcome, fixture.expected.outcome);
      assert.ok(trial.source.threadId.startsWith('fixture-thread-'));

      const harnessFeedbackRoot = seedIsolatedHarnessRoot();
      const artifact = generateSessionRecoveryLiveVerdict({
        verdictId: `session-recovery-fixture-${fixture.id}`,
        harnessFeedbackRoot,
        domain,
        selector: { ...fixture.selector, assessments: [fixture.assessment] },
        trials,
        submittedPacket: packet(fixture, trial),
        generatedAt: '2026-07-16T12:00:00.000Z',
        generatorCommit: 'isolated-fixture',
      });

      const raw = readFileSync(join(artifact.bundleDir, 'raw', 'session-recovery-trials.json'), 'utf8');
      assert.doesNotMatch(raw, /fixture-owner/);
      assert.doesNotMatch(raw, /SYNTHETIC_.*(?:TRANSCRIPT|RATIONALE)/);
      assert.equal(JSON.parse(raw).trials[0].assessment.rationale, undefined);

      const summary = loadEvalHubSummary({ harnessFeedbackRoot });
      assert.equal(summary.items.length, 1);
      const component = summary.items[0].trend.components[0];
      assert.equal(component.frictionCounts.structural_fail_count, fixture.expected.structuralFailCount);
      assert.equal(component.frictionCounts.semantic_fail_count, fixture.expected.semanticFailCount);
      assert.equal(component.frictionCounts.missing_target_count, fixture.expected.missingTargetCount);

      assert.equal(connectMock.mock.callCount(), 0, 'fixture path must not connect to Redis 6399 or any network');
      assert.ok(reads.every((read) => read.kind === 'session-scan' || read.kind === 'transcript-read'));
    });
  }
});
