import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCapabilityTrace,
  classifyCapabilityWakeupTrials,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/eval-capability-wakeup-adapter.js';
import { generateCapabilityWakeupLiveVerdict } from '../../dist/infrastructure/harness-eval/eval-capability-wakeup-live-verdict.js';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/eval-hub-read-model.js';

function transcriptEvent(eventNo, invocationId, event) {
  const baseTs = 1700000000000;
  return {
    v: 1,
    t: baseTs + eventNo * 60000,
    threadId: 'thread-cap',
    catId: 'gpt52',
    sessionId: 'session-cap',
    cliSessionId: 'cli-cap',
    invocationId,
    eventNo,
    event,
  };
}

const domain = {
  domainId: 'eval:capability-wakeup',
  displayName: 'Capability Wakeup Eval',
  systemThreadId: 'thread_eval_capability_wakeup',
  evalCat: { catId: 'opus47', handle: '@opus47', model: 'claude-opus-4-7' },
  frequency: 'weekly',
  sourceAdapter: 'capability-wakeup-eval',
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
      transcriptEvent(1, 'inv-2', {
        type: 'text',
        content: 'show me the options in a nicer format',
      }),
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
    {
      id: 'rich-text-trigger',
      capability: 'rich-messaging',
      predicate: {
        type: 'text_pattern_then_capability',
        capability: 'rich-messaging',
        patterns: ['show me', 'nicer format'],
      },
    },
  ]);
  return classifyCapabilityWakeupTrials(trace, trials);
}

describe('eval:capability-wakeup live verdict generator', () => {
  it('writes a live verdict and sanitized bundle for a capability miss cluster', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-capability-live-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    const verdictId = '2026-05-29-eval-capability-wakeup-live-verdict';
    const trials = buildTrials();

    const result = generateCapabilityWakeupLiveVerdict({
      verdictId,
      harnessFeedbackRoot,
      domain,
      capability: 'rich-messaging',
      trials,
      generatedAt: '2026-05-29T05:30:00.000Z',
      generatorCommit: 'test-commit',
    });

    assert.equal(result.isLive, true);
    assert.equal(result.sentCrossThreadMessage, false);
    assert.equal(result.packet.domainId, 'eval:capability-wakeup');
    assert.equal(result.packet.verdict, 'fix');
    assert.equal(result.packet.createdAt, '2026-05-29T05:30:00.000Z');
    assert.equal(existsSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'snapshot.json')), true);
    assert.equal(existsSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'attribution.json')), true);
    assert.equal(existsSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'provenance.json')), true);
    assert.equal(existsSync(join(root, 'generated', 'capability-wakeup', verdictId, 'trials.json')), true);
    assert.equal(existsSync(join(root, 'generated', 'capability-wakeup', verdictId, 'summary.json')), true);

    const snapshot = JSON.parse(readFileSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.components[0].id, 'rich-messaging');
    assert.equal(snapshot.components[0].frictionCounts.cognitive_count, 2);
    assert.equal(snapshot.window.startMs, 1700000000000);
    assert.equal(snapshot.window.endMs, 1700000060000);
    assert.equal(snapshot.window.durationHours, 0.017);

    const attribution = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'attribution.json'), 'utf8'),
    );
    assert.equal(attribution.findings[0].attribution.primaryLayer, 'cognitive');
    assert.equal(attribution.findings[0].attribution.evidence[0].anchor, 'rich-messaging/cognitive_count');

    const provenance = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', verdictId, 'provenance.json'), 'utf8'),
    );
    assert.deepEqual(
      provenance.rawInputs.map((input) => input.path),
      [`generated/capability-wakeup/${verdictId}/trials.json`, `generated/capability-wakeup/${verdictId}/summary.json`],
    );
    const trialsBytes = readFileSync(join(root, 'generated', 'capability-wakeup', verdictId, 'trials.json'));
    const summaryBytes = readFileSync(join(root, 'generated', 'capability-wakeup', verdictId, 'summary.json'));
    assert.equal(provenance.rawInputs[0].sha256, createHash('sha256').update(trialsBytes).digest('hex'));
    assert.equal(provenance.rawInputs[1].sha256, createHash('sha256').update(summaryBytes).digest('hex'));

    const markdown = readFileSync(result.path, 'utf8');
    assert.match(markdown, /domain_id: eval:capability-wakeup/);
    assert.match(markdown, /Live Verdict/);
    assert.match(markdown, new RegExp(`snapshot:bundle/${verdictId}/snapshot`));
  });

  it('lets Eval Hub load a capability-wakeup live verdict bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-capability-hub-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    const evalDomainsDir = join(harnessFeedbackRoot, 'eval-domains');
    const verdictId = '2026-05-29-eval-capability-wakeup-live-verdict';
    const trials = buildTrials();

    // minimal registered domain fixture for hub load
    mkdirSync(evalDomainsDir, { recursive: true });
    writeFileSync(
      join(evalDomainsDir, 'eval-capability-wakeup.yaml'),
      `---
domainId: eval:capability-wakeup
displayName: Capability Wakeup Eval
systemThreadId: thread_eval_capability_wakeup
evalCat:
  catId: opus47
  handle: "@opus47"
  model: claude-opus-4-7
frequency: weekly
sourceAdapter: capability-wakeup-eval
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F203
  ownerCatId: opus47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
`,
    );

    generateCapabilityWakeupLiveVerdict({
      verdictId,
      harnessFeedbackRoot,
      domain,
      capability: 'rich-messaging',
      trials,
      generatedAt: '2026-05-29T05:30:00.000Z',
      generatorCommit: 'test-commit',
    });

    const summary = loadEvalHubSummary({ harnessFeedbackRoot });
    assert.equal(summary.items.length, 1);
    assert.equal(summary.items[0].domainId, 'eval:capability-wakeup');
    assert.equal(summary.items[0].harnessUnderEval.componentId, 'rich-messaging');
    assert.equal(summary.items[0].systemWorkspace.id, 'eval:capability-wakeup');
  });

  it('supports keep_observe live verdicts when all trials are successful', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-capability-clean-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    const verdictId = '2026-05-29-eval-capability-wakeup-clean-window';
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-1', {
          type: 'tool_use',
          toolName: 'Write',
          toolInput: { file_path: 'docs/plans/demo.md' },
        }),
        transcriptEvent(1, 'inv-2', {
          type: 'text',
          content: '我已经把 docs/plans/demo.md 打开给你看了。',
        }),
      ],
      toolEvents: [
        {
          invocationId: 'inv-2',
          sessionId: 'session-cap',
          threadId: 'thread-cap',
          catId: 'gpt52',
          toolName: 'command_execution',
          timestamp: 1700000060000,
          turnIndex: 1,
          status: 'success',
          summary: {
            command: 'curl -X POST http://localhost:3004/api/workspace/navigate -H "Content-Type: application/json"',
            exitCode: 0,
            ok: true,
            path: 'docs/plans/demo.md',
            action: 'reveal',
          },
        },
      ],
    });
    const trials = classifyCapabilityWakeupTrials(
      trace,
      evaluateCapabilityWakeupTrace(trace, [
        {
          id: 'workspace-open-after-file-change',
          capability: 'workspace-navigator',
          predicate: {
            type: 'file_change_then_capability',
            capability: 'workspace-navigator',
            includeGlobs: ['docs/**'],
            requirePathMention: true,
          },
        },
      ]),
    );

    const result = generateCapabilityWakeupLiveVerdict({
      verdictId,
      harnessFeedbackRoot,
      domain,
      capability: 'workspace-navigator',
      trials,
      generatedAt: '2026-05-29T05:30:00.000Z',
      generatorCommit: 'test-commit',
    });

    assert.equal(result.packet.verdict, 'keep_observe');
    assert.equal(result.packet.ownerAsk.requestedAction, 'No action required; keep observing the next scheduled eval.');
    assert.deepEqual(result.packet.evidencePacket.attributionRefs, [
      `attribution:bundle/${verdictId}/eval-F203-workspace_navigator-2026-05-29:no-finding`,
    ]);
  });
});
