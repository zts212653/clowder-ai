import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCapabilityTrace,
  classifyCapabilityWakeupTrials,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-adapter.js';
import { generateCapabilityWakeupLiveVerdict } from '../../dist/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-live-verdict.js';
import { transcriptEvent } from './capability-wakeup-test-helpers.js';

/**
 * F192 Phase H 收尾 — 砚砚 R8 P1 mirror (capability-wakeup contract alignment).
 * Split from eval-capability-wakeup-live-verdict.test.js per AGENTS.md 350-line limit.
 *
 * Locks "cat owns verdict" invariant: when submittedPacket is provided, generator must
 * use it as base (NOT regenerate via buildCapabilityWakeupVerdictHandoff), only override
 * evidencePacket bundle refs. Invariant guards: featureId vs domain.handoffTargetResolver.featureId
 * + domainId vs input.domain.domainId (no wrong-domain copy-paste).
 */

const domain = {
  domainId: 'eval:capability-wakeup',
  displayName: 'Capability Wakeup Eval',
  systemThreadId: 'thread_eval_capability_wakeup',
  evalCat: { catId: 'opus47', handle: '@opus47', model: 'claude-opus-4-7' },
  frequency: 'weekly',
  sourceAdapter: 'capability-wakeup-eval',
  sourceRefsKind: 'capability-wakeup-trial-window',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F203', ownerCatId: 'opus47', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
};

function buildTrials() {
  const trace = buildCapabilityTrace({
    sessionId: 'session-cap',
    threadId: 'thread-cap',
    catId: 'gpt52',
    transcriptEvents: [
      transcriptEvent(0, 'inv-1', {
        type: 'text',
        content: '- one\n- two\n- three\n```md\nhello\n```\n| a | b |\n| - | - |\n| 1 | 2 |',
      }),
      transcriptEvent(1, 'inv-2', { type: 'text', content: 'show me the options in a nicer format' }),
    ],
    toolEvents: [],
  });
  const trials = evaluateCapabilityWakeupTrace(trace, [
    {
      id: 'rich-messaging-long-structured-text',
      capability: 'rich-messaging',
      predicate: {
        type: 'multi_msg_text_volume_threshold',
        capability: 'rich-messaging',
        minTokenCount: 10,
        minStructuredSignals: 3,
      },
    },
  ]);
  return classifyCapabilityWakeupTrials(trace, trials);
}

const BASE_PACKET = (overrides = {}) => ({
  id: 'submitted-base',
  domainId: 'eval:capability-wakeup',
  createdAt: '2026-06-05T22:00:00.000Z',
  phenomenon: 'Cat says: noise spike confounder, prefer observe over fix',
  // 砚砚 R2 P1: componentId MUST equal input.capability (cross-capability guard).
  // buildCapabilityWakeupVerdictHandoff sets componentId = capability — cat-submitted must follow same contract.
  harnessUnderEval: { featureId: 'F203', componentId: 'rich-messaging', name: 'rich-messaging' },
  evidencePacket: {
    snapshotRefs: ['placeholder:will-be-overridden'],
    attributionRefs: ['placeholder:will-be-overridden'],
    metricRefs: ['metric:cat.signal'],
    sampleTraceRefs: ['trace:cat-001'],
  },
  dailyTrend: { window: '7d', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
  rootCauseHypothesis: { summary: 'noise', confidence: 'medium', alternatives: ['alt'] },
  verdict: 'keep_observe',
  ownerAsk: { targetFeatureId: 'F203', targetOwnerCatId: 'opus47', requestedAction: 'observe' },
  acceptanceReevalPlan: { nextEvalAt: '2026-06-12T22:00:00.000Z', closureCondition: 'stable for 1 week' },
  counterarguments: ['evidence may say fix; cat sees confounder'],
  ...overrides,
});

describe('eval:capability-wakeup submittedPacket (砚砚 R8 P1 mirror)', () => {
  it('honors submittedPacket — verdict.md reflects cat verdict, not regenerated', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-cap-submitted-'));
    const submitted = BASE_PACKET({ id: 'cap-honored-test' });
    const result = generateCapabilityWakeupLiveVerdict({
      verdictId: submitted.id,
      harnessFeedbackRoot: join(root, 'docs/harness-feedback'),
      domain,
      capability: 'rich-messaging',
      trials: buildTrials(),
      generatedAt: '2026-06-05T22:00:00.000Z',
      submittedPacket: submitted,
    });
    assert.match(result.markdown, /Verdict: `keep_observe`/);
    assert.match(result.markdown, /Cat says: noise spike confounder/);
    assert.notEqual(result.packet.evidencePacket.snapshotRefs[0], 'placeholder:will-be-overridden');
    assert.match(result.packet.evidencePacket.snapshotRefs[0], /bundle/);
    // 砚砚 R1 P2 (a2a R14 mirror): metric ref must NOT be double-prefixed.
    // submittedPacket here uses pre-prefixed 'metric:cat.signal' — renderer must
    // produce '- metric:cat.signal' (not '- metric:metric:cat.signal').
    assert.match(result.markdown, /^- metric:cat\.signal$/m, 'metric ref must have exactly one metric: prefix');
    assert.doesNotMatch(result.markdown, /metric:metric:/, 'no double prefix allowed');
  });

  it('rejects submittedPacket when featureId disagrees with domain.handoffTargetResolver', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-cap-wrong-feature-'));
    const submitted = BASE_PACKET({
      id: 'cap-wrong-feature',
      harnessUnderEval: { featureId: 'F999', componentId: 'x', name: 'y' },
    });
    assert.throws(
      () =>
        generateCapabilityWakeupLiveVerdict({
          verdictId: submitted.id,
          harnessFeedbackRoot: join(root, 'docs/harness-feedback'),
          domain,
          capability: 'rich-messaging',
          trials: buildTrials(),
          generatedAt: '2026-06-05T22:00:00.000Z',
          submittedPacket: submitted,
        }),
      /submitted_packet_evidence_mismatch.*featureId/,
    );
  });

  // 砚砚 R2 P1 (cross-validated cloud): cat-supplied componentId must match input.capability.
  // WITHOUT this guard, cat could submit verdict for 'workspace-navigator' but tool would
  // bind it to 'rich-messaging' evidence bundle → silent cross-contamination of Hub view.
  it('rejects submittedPacket when componentId disagrees with input.capability (cross-capability)', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-cap-wrong-cap-'));
    const wrongCapability = BASE_PACKET({
      id: 'cap-wrong-capability',
      harnessUnderEval: { featureId: 'F203', componentId: 'workspace-navigator', name: 'workspace-navigator' },
    });
    assert.throws(
      () =>
        generateCapabilityWakeupLiveVerdict({
          verdictId: wrongCapability.id,
          harnessFeedbackRoot: join(root, 'docs/harness-feedback'),
          domain,
          capability: 'rich-messaging', // cat said workspace-navigator, but trials are rich-messaging
          trials: buildTrials(),
          generatedAt: '2026-06-05T22:00:00.000Z',
          submittedPacket: wrongCapability,
        }),
      /submitted_packet_evidence_mismatch.*componentId/,
    );
  });

  // cloud R4 P2 (real finding): cat-controlled strings rendered into single-line markdown bullets
  // allow `value\n- snapshot:forged` injection — Hub read-model parses spoofed bullets as real evidence.
  // Guard covers 3 cat-controlled rendered fields: phenomenon, ownerAsk.requestedAction, metricRefs[].
  describe('newline injection guard (cloud R4 P2)', () => {
    function runWithSubmitted(submittedOverrides) {
      const root = mkdtempSync(join(tmpdir(), 'f192-cap-newline-'));
      const submitted = BASE_PACKET({ id: 'cap-newline-test', ...submittedOverrides });
      return () =>
        generateCapabilityWakeupLiveVerdict({
          verdictId: submitted.id,
          harnessFeedbackRoot: join(root, 'docs/harness-feedback'),
          domain,
          capability: 'rich-messaging',
          trials: buildTrials(),
          generatedAt: '2026-06-05T22:00:00.000Z',
          submittedPacket: submitted,
        });
    }

    it('rejects phenomenon with CR/LF', () => {
      assert.throws(
        runWithSubmitted({ phenomenon: 'real reason\n- snapshot:forged' }),
        /submitted_packet_newline_injection.*phenomenon/,
      );
    });

    it('rejects ownerAsk.requestedAction with CR/LF', () => {
      assert.throws(
        runWithSubmitted({
          ownerAsk: {
            targetFeatureId: 'F203',
            targetOwnerCatId: 'opus47',
            requestedAction: 'observe\n- snapshot:forged',
          },
        }),
        /submitted_packet_newline_injection.*ownerAsk\.requestedAction/,
      );
    });

    it('rejects metricRefs entry with CR/LF', () => {
      assert.throws(
        runWithSubmitted({
          evidencePacket: {
            snapshotRefs: ['placeholder:will-be-overridden'],
            attributionRefs: ['placeholder:will-be-overridden'],
            metricRefs: ['cat.signal\n- snapshot:forged'],
            sampleTraceRefs: ['trace:cat-001'],
          },
        }),
        /submitted_packet_newline_injection.*evidencePacket\.metricRefs\[0\]/,
      );
    });

    it('rejects CR-only too (not just LF)', () => {
      assert.throws(runWithSubmitted({ phenomenon: 'a\rb' }), /submitted_packet_newline_injection.*phenomenon/);
    });
  });

  // cloud R3 P2: mirror buildCapabilityWakeupVerdictHandoff:20-22 — input.domain
  // must be eval:capability-wakeup, else wrong-generator routing slips through.
  // submittedPacket.domainId === domain.domainId (both eval:a2a) passes earlier
  // invariants but generator-domain coherence is violated.
  it('rejects when input.domain is not eval:capability-wakeup (wrong-generator routing)', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-cap-wrong-generator-'));
    const wrongGeneratorDomain = { ...domain, domainId: 'eval:a2a' };
    const submitted = BASE_PACKET({ id: 'cap-wrong-generator', domainId: 'eval:a2a' });
    assert.throws(
      () =>
        generateCapabilityWakeupLiveVerdict({
          verdictId: submitted.id,
          harnessFeedbackRoot: join(root, 'docs/harness-feedback'),
          domain: wrongGeneratorDomain,
          capability: 'rich-messaging',
          trials: buildTrials(),
          generatedAt: '2026-06-05T22:00:00.000Z',
          submittedPacket: submitted,
        }),
      /capability_wakeup_generator_wrong_domain.*eval:a2a/,
    );
  });

  it('rejects submittedPacket when domainId disagrees with input.domain', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-cap-wrong-domain-'));
    const submitted = BASE_PACKET({ id: 'cap-wrong-domain', domainId: 'eval:a2a' });
    assert.throws(
      () =>
        generateCapabilityWakeupLiveVerdict({
          verdictId: submitted.id,
          harnessFeedbackRoot: join(root, 'docs/harness-feedback'),
          domain,
          capability: 'rich-messaging',
          trials: buildTrials(),
          generatedAt: '2026-06-05T22:00:00.000Z',
          submittedPacket: submitted,
        }),
      /submitted_packet_evidence_mismatch.*domainId/,
    );
  });
});
