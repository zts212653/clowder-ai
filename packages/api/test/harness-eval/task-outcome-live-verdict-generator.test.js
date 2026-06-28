import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { EventMemoryStore } from '../../dist/domains/memory/EventMemoryStore.js';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';
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
    `domainId: eval:task-outcome
displayName: Task Outcome Eval
systemThreadId: thread_eval_task_outcome
evalCat:
  catId: opus-47
  handle: "@opus-47"
  model: claude-opus-4-7
frequency: daily
sourceAdapter: task-outcome-eval
sourceRefsKind: task-outcome-snapshot
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F192
  ownerCatId: opus
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
`,
  );
}

async function seedWindow(
  root,
  taskOutcomeDbPath = join(root, 'task-outcome-episodes.sqlite'),
  eventMemoryDbPath = join(root, 'event-memory.sqlite'),
) {
  const baseMs = Date.now();
  const store = new TaskOutcomeEpisodeStore(taskOutcomeDbPath);
  const eventStore = new EventMemoryStore(eventMemoryDbPath);
  await eventStore.initialize();

  const completed = store.createEpisode({
    trigger: 'cat_initiated',
    threadId: 'thread-1',
    participants: ['gpt52'],
  });
  store.appendSignal(completed.episodeId, {
    category: 'a1',
    record: {
      type: 'merge',
      ref: 'PR#2162',
      outcome: 'success',
      timestamp: new Date(baseMs + 1_000).toISOString(),
    },
  });
  store.appendSignal(completed.episodeId, {
    category: 'a2',
    record: {
      type: 'proposal_reject',
      proposalId: 'prop-1',
      proposalType: 'thread',
      catId: 'gpt52',
      threadId: 'thread-1',
      timestamp: new Date(baseMs + 2_000).toISOString(),
    },
  });
  store.updateTerminalState(completed.episodeId, 'completed');

  const inProgress = store.createEpisode({
    trigger: 'cat_initiated',
    threadId: 'thread-2',
    participants: ['gpt52'],
  });
  const linkedEvent = eventStore.markEvent(
    {
      type: 'magic_word',
      trigger: 'human_brake',
      cat: 'gpt52',
      threadId: 'thread-2',
      messageId: 'msg-1',
      timestamp: baseMs + 5_000,
      summary: '用户拉闸',
      cognitiveTransition: 'user_brake',
      relatedHarness: ['F227'],
      confidence: 'high',
    },
    'you',
  );
  store.appendSignal(inProgress.episodeId, {
    category: 'a2',
    record: {
      type: 'magic_word_ref',
      eventId: linkedEvent.event.eventId,
      word: '绕路了',
      timestamp: new Date(baseMs + 3_000).toISOString(),
      threadId: 'thread-2',
      catId: 'gpt52',
    },
  });
  store.appendSignal(inProgress.episodeId, {
    category: 'proxy',
    record: {
      type: 'cancel_burst',
      value: 3,
      timestamp: new Date(baseMs + 4_000).toISOString(),
      threadId: 'thread-2',
    },
  });
  const futureLinkedEvent = eventStore.markEvent(
    {
      type: 'magic_word',
      trigger: 'human_brake',
      cat: 'gpt52',
      threadId: 'thread-2',
      messageId: 'msg-future',
      timestamp: baseMs + 8_000,
      summary: '只该被 future signal 链接到',
      cognitiveTransition: 'user_brake',
      relatedHarness: ['F227'],
      confidence: 'mid',
    },
    'you',
  );
  store.appendSignal(inProgress.episodeId, {
    category: 'a2',
    record: {
      type: 'magic_word_ref',
      eventId: futureLinkedEvent.event.eventId,
      word: '以后才发生',
      timestamp: new Date(baseMs + 65_000).toISOString(),
      threadId: 'thread-2',
      catId: 'gpt52',
    },
  });
  const taskOutcomeDb = new Database(taskOutcomeDbPath);
  taskOutcomeDb
    .prepare(`UPDATE task_outcome_signals SET createdAt = ? WHERE id = (SELECT MAX(id) FROM task_outcome_signals)`)
    .run(new Date(baseMs + 65_000).toISOString());
  eventStore.markEvent(
    {
      type: 'magic_word',
      trigger: 'human_brake',
      cat: 'gpt52',
      threadId: 'thread-unrelated',
      messageId: 'msg-2',
      timestamp: baseMs + 6_000,
      summary: '同 owner 但不在 linked event refs 里',
      cognitiveTransition: 'user_brake',
      relatedHarness: ['F227'],
      confidence: 'low',
    },
    'you',
  );
  eventStore.markEvent(
    {
      type: 'magic_word',
      trigger: 'human_brake',
      cat: 'gpt52',
      threadId: 'thread-2',
      messageId: 'msg-3',
      timestamp: baseMs + 7_000,
      summary: '同线程但属于另一个 owner',
      cognitiveTransition: 'user_brake',
      relatedHarness: ['F227'],
      confidence: 'mid',
    },
    'other-user',
  );

  return { taskOutcomeDbPath, eventMemoryDbPath, baseMs };
}

function buildPacket(overrides = {}) {
  return {
    id: 'vhp-task-outcome-live-test',
    domainId: 'eval:task-outcome',
    createdAt: '2026-06-09T03:30:00.000Z',
    phenomenon: 'task outcome live verdict test',
    harnessUnderEval: {
      featureId: 'F192',
      componentId: 'Phase-G-v0',
      name: 'task-outcome eval pipeline',
    },
    evidencePacket: {
      snapshotRefs: ['placeholder:overridden'],
      attributionRefs: ['placeholder:overridden'],
      metricRefs: ['metric:task_outcome.episodes_total'],
      sampleTraceRefs: ['thread:thread-1'],
    },
    dailyTrend: {
      window: '24h',
      current: { episodes_total: 2 },
      baseline: { episodes_total: 1 },
      threshold: { episodes_total: 5 },
      direction: 'flat',
    },
    rootCauseHypothesis: {
      summary: 'task outcome window needs observation',
      confidence: 'medium',
      alternatives: ['small sample'],
    },
    verdict: 'keep_observe',
    ownerAsk: {
      targetFeatureId: 'F192',
      targetOwnerCatId: 'opus',
      requestedAction: 'observe',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-06-10T03:00:00.000Z',
      closureCondition: 'next eval remains stable',
    },
    counterarguments: ['signal mix may be low volume noise'],
    ...overrides,
  };
}

describe('eval:task-outcome live verdict generator', () => {
  it('writes a live verdict bundle and raw replay artifact for a task-outcome window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-task-outcome-live-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    seedRegistry(harnessFeedbackRoot);
    const { baseMs } = await seedWindow(root);
    const sourceWindow = resolveTaskOutcomeSourceWindow(
      {
        kind: 'task-outcome-snapshot',
        windowStartMs: baseMs - 60_000,
        windowEndMs: baseMs + 60_000,
      },
      harnessFeedbackRoot,
      { ownerUserId: 'you' },
    );

    const result = generateTaskOutcomeLiveVerdict({
      verdictId: '2026-06-09-eval-task-outcome-live-verdict',
      harnessFeedbackRoot,
      domain,
      sourceWindow,
      submittedPacket: buildPacket({
        id: '2026-06-09-eval-task-outcome-live-verdict',
        phenomenon: 'window shows one open episode and one proposal reject',
      }),
      generatedAt: '2026-06-09T03:30:00.000Z',
      generatorCommit: 'test-commit',
    });

    assert.equal(result.isLive, true);
    assert.equal(result.packet.domainId, 'eval:task-outcome');
    assert.equal(
      sourceWindow.signals.filter((signal) => signal.record.type === 'magic_word_ref').length,
      1,
      'future-window magic_word_ref must not leak into the selected verdict window',
    );
    assert.equal(sourceWindow.eventRows.length, 1);
    assert.equal(sourceWindow.eventRows[0].threadId, 'thread-2');
    assert.equal(sourceWindow.eventRows[0].summary, '用户拉闸');
    assert.equal(
      existsSync(join(harnessFeedbackRoot, 'bundles', '2026-06-09-eval-task-outcome-live-verdict', 'snapshot.json')),
      true,
    );
    assert.equal(
      existsSync(join(harnessFeedbackRoot, 'bundles', '2026-06-09-eval-task-outcome-live-verdict', 'attribution.json')),
      true,
    );
    assert.equal(
      existsSync(join(harnessFeedbackRoot, 'bundles', '2026-06-09-eval-task-outcome-live-verdict', 'provenance.json')),
      true,
    );
    assert.equal(
      existsSync(
        join(harnessFeedbackRoot, 'bundles', '2026-06-09-eval-task-outcome-live-verdict', 'raw', 'episodes.json'),
      ),
      true,
    );

    const snapshot = JSON.parse(
      readFileSync(
        join(harnessFeedbackRoot, 'bundles', '2026-06-09-eval-task-outcome-live-verdict', 'snapshot.json'),
        'utf8',
      ),
    );
    assert.equal(snapshot.components[0].id, 'Phase-G-v0');
    assert.equal(snapshot.components[0].activationCounts.episodes_total, 2);
    assert.equal(snapshot.components[0].activationCounts.completed_total, 1);
    assert.equal(snapshot.components[0].activationCounts.in_progress_total, 1);
    assert.equal(snapshot.components[0].frictionCounts.proposal_reject_total, 1);
    assert.equal(snapshot.components[0].frictionCounts.magic_word_ref_total, 1);
    assert.equal(snapshot.components[1].id, 'F227-event-memory');
    assert.equal(snapshot.components[1].activationCounts.events_backfilled_visible, 1);
    assert.equal(snapshot.components[1].activationCounts.confidence_high_count, 1);
    assert.equal(snapshot.components[1].activationCounts.confidence_low_count, 0);

    const attribution = JSON.parse(
      readFileSync(
        join(harnessFeedbackRoot, 'bundles', '2026-06-09-eval-task-outcome-live-verdict', 'attribution.json'),
        'utf8',
      ),
    );
    assert.equal(attribution.findings[0].attribution.evidence[0].anchor, 'Phase-G-v0/in_progress_total');

    const rawPath = join(
      harnessFeedbackRoot,
      'bundles',
      '2026-06-09-eval-task-outcome-live-verdict',
      'raw',
      'episodes.json',
    );
    const provenance = JSON.parse(
      readFileSync(
        join(harnessFeedbackRoot, 'bundles', '2026-06-09-eval-task-outcome-live-verdict', 'provenance.json'),
        'utf8',
      ),
    );
    const rawBytes = readFileSync(rawPath);
    assert.equal(
      provenance.rawInputs[0].path,
      'docs/harness-feedback/bundles/2026-06-09-eval-task-outcome-live-verdict/raw/episodes.json',
    );
    assert.equal(provenance.rawInputs[0].sha256, createHash('sha256').update(rawBytes).digest('hex'));

    const markdown = readFileSync(result.path, 'utf8');
    assert.match(markdown, /domain_id: eval:task-outcome/);
    assert.match(markdown, /snapshot:bundle\/2026-06-09-eval-task-outcome-live-verdict\/snapshot/);
  });

  it('lets Eval Hub load a task-outcome live verdict bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-task-outcome-hub-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    seedRegistry(harnessFeedbackRoot);
    const { baseMs } = await seedWindow(root);
    const sourceWindow = resolveTaskOutcomeSourceWindow(
      {
        kind: 'task-outcome-snapshot',
        windowStartMs: baseMs - 60_000,
        windowEndMs: baseMs + 60_000,
      },
      harnessFeedbackRoot,
      { ownerUserId: 'you' },
    );

    generateTaskOutcomeLiveVerdict({
      verdictId: '2026-06-09-eval-task-outcome-live-verdict',
      harnessFeedbackRoot,
      domain,
      sourceWindow,
      submittedPacket: buildPacket({
        id: '2026-06-09-eval-task-outcome-live-verdict',
        phenomenon: 'window shows one open episode and one proposal reject',
      }),
      generatedAt: '2026-06-09T03:30:00.000Z',
      generatorCommit: 'test-commit',
    });

    const summary = loadEvalHubSummary({ harnessFeedbackRoot });
    assert.equal(summary.items.length, 1);
    assert.equal(summary.items[0].domainId, 'eval:task-outcome');
    assert.equal(summary.items[0].harnessUnderEval.componentId, 'Phase-G-v0');
    assert.equal(summary.items[0].systemWorkspace.id, 'eval:task-outcome');
  });

  it('rejects absolute or escaping databasePath overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-task-outcome-path-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    seedRegistry(harnessFeedbackRoot);
    const { taskOutcomeDbPath, baseMs } = await seedWindow(root);

    assert.throws(
      () =>
        resolveTaskOutcomeSourceWindow(
          {
            kind: 'task-outcome-snapshot',
            windowStartMs: baseMs - 60_000,
            windowEndMs: baseMs + 60_000,
            databasePath: taskOutcomeDbPath,
          },
          harnessFeedbackRoot,
          { ownerUserId: 'you' },
        ),
      /invalid_source_ref: databasePath must be repo-relative/i,
    );

    assert.throws(
      () =>
        resolveTaskOutcomeSourceWindow(
          {
            kind: 'task-outcome-snapshot',
            windowStartMs: baseMs - 60_000,
            windowEndMs: baseMs + 60_000,
            databasePath: '../task-outcome-episodes.sqlite',
          },
          harnessFeedbackRoot,
          { ownerUserId: 'you' },
        ),
      /invalid_source_ref: databasePath escapes the repo-root allowlist/i,
    );
  });

  it('requires ownerUserId when linked event refs exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-task-outcome-owner-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    seedRegistry(harnessFeedbackRoot);
    const { baseMs } = await seedWindow(root);

    assert.throws(
      () =>
        resolveTaskOutcomeSourceWindow(
          {
            kind: 'task-outcome-snapshot',
            windowStartMs: baseMs - 60_000,
            windowEndMs: baseMs + 60_000,
          },
          harnessFeedbackRoot,
        ),
      /internal_owner_scope_missing/i,
    );
  });

  it('uses runtime-configured defaultTaskOutcomeDbPath when selector omits databasePath', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-task-outcome-configured-path-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    const customTaskOutcomeDbPath = join(tmpdir(), `task-outcome-configured-${Date.now()}.sqlite`);
    seedRegistry(harnessFeedbackRoot);
    const { baseMs } = await seedWindow(root, customTaskOutcomeDbPath);

    const sourceWindow = resolveTaskOutcomeSourceWindow(
      {
        kind: 'task-outcome-snapshot',
        windowStartMs: baseMs - 60_000,
        windowEndMs: baseMs + 60_000,
      },
      harnessFeedbackRoot,
      {
        ownerUserId: 'you',
        defaultTaskOutcomeDbPath: customTaskOutcomeDbPath,
      },
    );

    assert.equal(sourceWindow.episodes.length, 2);
    assert.equal(sourceWindow.taskOutcomeDbPath, customTaskOutcomeDbPath);
  });

  it('uses runtime-configured defaultEventMemoryDbPath when linked events live outside repo root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-task-outcome-configured-event-memory-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    const customEventMemoryDbPath = join(tmpdir(), `event-memory-configured-${Date.now()}.sqlite`);
    seedRegistry(harnessFeedbackRoot);
    const { baseMs } = await seedWindow(root, join(root, 'task-outcome-episodes.sqlite'), customEventMemoryDbPath);

    const sourceWindow = resolveTaskOutcomeSourceWindow(
      {
        kind: 'task-outcome-snapshot',
        windowStartMs: baseMs - 60_000,
        windowEndMs: baseMs + 60_000,
      },
      harnessFeedbackRoot,
      {
        ownerUserId: 'you',
        defaultEventMemoryDbPath: customEventMemoryDbPath,
      },
    );

    assert.equal(sourceWindow.eventMemoryDbPath, customEventMemoryDbPath);
    assert.equal(sourceWindow.eventRows.length, 1);
    assert.equal(sourceWindow.eventRows[0].summary, '用户拉闸');
  });
});
