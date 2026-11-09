import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexCapacityRecoveryCheckpoint } from '../dist/domains/cats/services/agents/providers/CodexCapacityRecoveryCheckpoint.js';
import { formatAnchors } from '../dist/domains/cats/services/agents/routing/context-transport.js';
import { extractDecisionSignals } from '../dist/domains/cats/services/session/extractDecisionSignals.js';
import { projectInvocationTrajectories } from '../dist/domains/cats/services/session/InvocationTrajectoryProjector.js';
import { formatEventsHandoff } from '../dist/domains/cats/services/session/TranscriptFormatter.js';
import { compactTranscriptEvent } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-compact-event.js';
import { parseNaturalLanguageOutput } from '../dist/domains/memory/abstractive-summary-output.js';
import { projectThreadMessageSummary } from '../dist/domains/memory/thread-summary-projection.js';

function assertValidText(text) {
  assert.ok(text.isWellFormed(), 'bounded prompt text must not contain lone UTF-16 surrogates');
  assert.ok(!text.includes('\uFFFD'), 'preserve complete characters instead of repairing broken pairs');
}

test('historical anchors keep complete emoji within their preview budget', () => {
  const message = { id: 'm', timestamp: 0, catId: null, content: `${'a'.repeat(59)}😼tail` };
  const [line] = formatAnchors([{ message, isPrimacy: true }], 60);
  assertValidText(line);
  assert.ok(line.endsWith(`${'a'.repeat(59)}...`));
});

test('transcript handoff key messages preserve Unicode at unit 80', () => {
  const [summary] = formatEventsHandoff([
    { invocationId: 'i', t: 0, event: { type: 'text', content: `${'a'.repeat(79)}😼tail` } },
  ]);
  assertValidText(summary.keyMessages[0]);
  assert.equal(summary.keyMessages[0], 'a'.repeat(79));
});

test('thread summaries stay well formed at their 3000-unit cap', () => {
  const summary = projectThreadMessageSummary(
    [{ id: 'm', content: `${'a'.repeat(2997 - '[user] '.length - 1)}😼tail` }],
    new Set(),
  );
  assertValidText(summary);
  assert.ok(summary.length <= 3000);
  assert.ok(summary.endsWith('...'));
});

test('fallback summary titles preserve Unicode at unit 80', () => {
  const result = parseNaturalLanguageOutput(`${'a'.repeat(79)}😼title\nSummary text here.`, {
    threadId: 'thread-1',
    messages: [{ id: 'm' }],
  });
  assert.ok(result);
  assertValidText(result.segments[0].topicLabel);
  assert.equal(result.segments[0].topicLabel, 'a'.repeat(79));
});

test('decision signals do not persist half an emoji into thread memory', () => {
  const result = extractDecisionSignals({
    transcriptText: `决定${'a'.repeat(97)}😼tail`,
    summaryConclusions: [],
    summaryOpenQuestions: [],
  });
  assert.equal(result.decisions.length, 1);
  assertValidText(result.decisions[0]);
  assert.ok(result.decisions[0].length <= 100);
});

test('Codex recovery checkpoints preserve Unicode in clipped plan steps', () => {
  const checkpoint = new CodexCapacityRecoveryCheckpoint();
  checkpoint.observe({
    type: 'turn.plan.updated',
    plan: [{ step: `${'a'.repeat(319)}😼tail`, status: 'inProgress' }],
  });
  assertValidText(checkpoint.nextIncompleteStep().step);
  assert.equal(checkpoint.nextIncompleteStep().step.length, 319);
});

const trajectorySession = { id: 's', threadId: 't', catId: 'codex61-sol', seq: 0, status: 'active' };
function trajectoryEvent(prefixLength) {
  return {
    v: 1,
    t: 0,
    invocationId: 'i',
    eventNo: 0,
    event: { type: 'text', content: `${'a'.repeat(prefixLength)}😼tail` },
  };
}

test('raw invocation trajectory previews keep complete characters at unit 140', () => {
  const [summary] = projectInvocationTrajectories([trajectoryEvent(139)], trajectorySession);
  assertValidText(summary.keyMessages[0]);
  assert.equal(summary.keyMessages[0], 'a'.repeat(139));
});

test('compact transcript projections stay valid before they feed invocation summaries', () => {
  for (const prefixLength of [138, 139, 140]) {
    const { projection } = compactTranscriptEvent(trajectoryEvent(prefixLength));
    assertValidText(projection.event.content);
    const [summary] = projectInvocationTrajectories([projection], trajectorySession);
    assertValidText(summary.keyMessages[0]);
    assert.equal(summary.keyMessages[0], `${'a'.repeat(prefixLength)}${prefixLength === 138 ? '😼' : ''}`);
  }
});
