/**
 * F192 Day-24 verdict P1 — live verdict snapshot must deduplicate
 * magic_word_ref signals by eventId.
 *
 * Historical data may contain duplicate rows from the pre-idempotency-guard
 * era. The eval snapshot must count distinct eventIds, not raw signal rows.
 *
 * [宪宪/Opus-46🐾]
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { generateTaskOutcomeLiveVerdict } from '../../dist/infrastructure/harness-eval/task-outcome/eval-task-outcome-live-verdict.js';
import { resolveTaskOutcomeSourceWindow } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-source-resolver.js';
import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

const domain = {
  domainId: 'eval:task-outcome',
  displayName: 'Task Outcome Eval',
  systemThreadId: 'thread_eval_task_outcome',
  evalCat: { catId: 'opus-47', handle: '@opus-47', model: 'claude-opus-4-7' },
  frequency: 'daily',
  sourceAdapter: 'task-outcome-eval',
  sourceRefsKind: 'task-outcome-snapshot',
  threadPolicy: {
    role: 'working-home',
    stateSot: 'registry',
    allowedContent: ['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts'],
  },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: { featureId: 'F192', ownerCatId: 'opus', threadLookup: 'feature-thread' },
  sla: { acknowledgeHours: 48, reevalWithinHours: 168 },
};

function seedRegistry(harnessFeedbackRoot) {
  const evalDomainsDir = join(harnessFeedbackRoot, 'eval-domains');
  mkdirSync(evalDomainsDir, { recursive: true });
  writeFileSync(
    join(evalDomainsDir, 'eval-task-outcome.yaml'),
    [
      'domainId: eval:task-outcome',
      'displayName: Task Outcome Eval',
      'systemThreadId: thread_eval_task_outcome',
      'evalCat:',
      '  catId: opus-47',
      '  handle: "@opus-47"',
      '  model: claude-opus-4-7',
      'frequency: daily',
      'sourceAdapter: task-outcome-eval',
      'sourceRefsKind: task-outcome-snapshot',
      'threadPolicy:',
      '  role: working-home',
      '  stateSot: registry',
      '  allowedContent:',
      '    - longitudinal-analysis',
      '    - verdict-discussion',
      '    - handoff-drafts',
      'legacyScheduledTaskIds: []',
      'handoffTargetResolver:',
      '  featureId: F192',
      '  ownerCatId: opus',
      '  threadLookup: feature-thread',
      'sla:',
      '  acknowledgeHours: 48',
      '  reevalWithinHours: 168',
      '',
    ].join('\n'),
  );
}

function buildPacket(overrides = {}) {
  return {
    id: 'vhp-dedup-test',
    domainId: 'eval:task-outcome',
    createdAt: '2026-07-03T03:30:00.000Z',
    phenomenon: 'dedup test',
    harnessUnderEval: { featureId: 'F192', componentId: 'Phase-G-v0', name: 'task-outcome eval pipeline' },
    evidencePacket: {
      snapshotRefs: ['placeholder:overridden'],
      attributionRefs: ['placeholder:overridden'],
      metricRefs: ['metric:task_outcome.episodes_total'],
      sampleTraceRefs: ['thread:thread-dedup'],
    },
    dailyTrend: {
      window: '24h',
      current: { episodes_total: 1 },
      baseline: { episodes_total: 1 },
      threshold: { episodes_total: 5 },
      direction: 'flat',
    },
    rootCauseHypothesis: { summary: 'dedup test', confidence: 'medium', alternatives: ['small sample'] },
    verdict: 'fix',
    ownerAsk: { targetFeatureId: 'F192', targetOwnerCatId: 'opus', requestedAction: 'fix' },
    acceptanceReevalPlan: { nextEvalAt: '2026-07-04T03:00:00.000Z', closureCondition: 'dedup passes' },
    counterarguments: ['low volume noise'],
    ...overrides,
  };
}

describe('magic_word_ref_total dedup in live verdict snapshot (Day-24 P1)', () => {
  it('counts distinct eventIds, not raw signal rows, for historical duplicates', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-mwr-dedup-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    seedRegistry(harnessFeedbackRoot);

    const baseMs = Date.now();
    const dbPath = join(root, 'task-outcome-episodes.sqlite');
    const store = new TaskOutcomeEpisodeStore(dbPath);
    const ep = store.createEpisode({ trigger: 'cat_initiated', threadId: 'thread-dedup', participants: ['opus'] });

    // Simulate historical duplicates: same eventId inserted 4 times
    // (pre-idempotency-guard behavior — no idempotencyKey)
    for (let i = 0; i < 4; i++) {
      store.appendSignal(ep.episodeId, {
        category: 'a2',
        record: {
          type: 'magic_word_ref',
          eventId: 'evt_same_id',
          word: '下次一定',
          timestamp: new Date(baseMs + i * 1000).toISOString(),
          threadId: 'thread-dedup',
          catId: 'opus',
        },
      });
    }
    // One signal with a different eventId
    store.appendSignal(ep.episodeId, {
      category: 'a2',
      record: {
        type: 'magic_word_ref',
        eventId: 'evt_different',
        word: '脚手架',
        timestamp: new Date(baseMs + 5000).toISOString(),
        threadId: 'thread-dedup',
        catId: 'opus',
      },
    });
    store.updateTerminalState(ep.episodeId, 'completed');

    const sourceWindow = resolveTaskOutcomeSourceWindow(
      { kind: 'task-outcome-snapshot', windowStartMs: baseMs - 60_000, windowEndMs: baseMs + 60_000 },
      harnessFeedbackRoot,
      { defaultTaskOutcomeDbPath: dbPath, defaultEventMemoryDbPath: null },
    );

    // Pre-condition: raw data has 5 signal rows (4 dupes + 1 unique)
    const rawMwr = sourceWindow.signals.filter((s) => s.record.type === 'magic_word_ref');
    assert.equal(rawMwr.length, 5, 'raw signals should have 5 rows');

    generateTaskOutcomeLiveVerdict({
      verdictId: '2026-07-03-dedup-test',
      harnessFeedbackRoot,
      domain,
      sourceWindow,
      submittedPacket: buildPacket({ id: '2026-07-03-dedup-test' }),
      generatedAt: '2026-07-03T03:30:00.000Z',
    });

    const snapshot = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', '2026-07-03-dedup-test', 'snapshot.json'), 'utf8'),
    );
    // KEY ASSERTION: 2 distinct eventIds, not 5 raw rows
    assert.equal(
      snapshot.components[0].frictionCounts.magic_word_ref_total,
      2,
      'magic_word_ref_total must count distinct eventIds, not raw signal rows',
    );
  });
});
