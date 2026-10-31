/**
 * F192 Day-36 verdict — cluster-aware A2 rollup metrics.
 *
 * Raw A2 event counts can't distinguish repeated independent friction
 * from clustered interventions (e.g. one operator message with 4 magic words
 * counts as 4 A2 signals, but is really 1 intervention). These tests
 * verify the new cluster metrics in the live verdict snapshot.
 *
 * Evidence: PR #2983 (verdict bundle 2026-07-16-task-outcome-build-a2-cluster-metrics)
 *
 * [宪宪/Opus-46🐾]
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
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
    id: 'vhp-cluster-test',
    domainId: 'eval:task-outcome',
    createdAt: '2026-07-16T03:00:00.000Z',
    phenomenon: 'cluster metrics test',
    harnessUnderEval: { featureId: 'F192', componentId: 'Phase-G-v0', name: 'task-outcome eval pipeline' },
    evidencePacket: {
      snapshotRefs: ['placeholder:overridden'],
      attributionRefs: ['placeholder:overridden'],
      metricRefs: ['metric:task_outcome.episodes_total'],
      sampleTraceRefs: ['thread:thread-cluster'],
    },
    dailyTrend: {
      window: '24h',
      current: { episodes_total: 3 },
      baseline: { episodes_total: 1 },
      threshold: { episodes_total: 5 },
      direction: 'regressed',
    },
    rootCauseHypothesis: { summary: 'cluster metrics test', confidence: 'medium', alternatives: ['noise'] },
    verdict: 'build',
    ownerAsk: { targetFeatureId: 'F192', targetOwnerCatId: 'opus', requestedAction: 'build cluster-aware A2 rollup' },
    acceptanceReevalPlan: { nextEvalAt: '2026-07-17T03:00:00.000Z', closureCondition: 'cluster metrics present' },
    counterarguments: ['raw count high but cluster count low'],
    ...overrides,
  };
}

/**
 * Create a temporary event-memory SQLite DB with the given events.
 * Returns the db path.
 */
function seedEventMemoryDb(root, ownerUserId, events) {
  const dbPath = join(root, 'event-memory.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_memory (
      eventId TEXT NOT NULL,
      ownerUserId TEXT NOT NULL,
      type TEXT NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'auto',
      cat TEXT NOT NULL DEFAULT '',
      threadId TEXT NOT NULL DEFAULT '',
      messageId TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT 'high',
      PRIMARY KEY (eventId, ownerUserId)
    )
  `);
  const insert = db.prepare(`
    INSERT INTO event_memory (eventId, ownerUserId, type, trigger_type, cat, threadId, messageId, timestamp, summary, confidence)
    VALUES (@eventId, @ownerUserId, @type, @trigger_type, @cat, @threadId, @messageId, @timestamp, @summary, @confidence)
  `);
  for (const evt of events) {
    insert.run({ ...evt, ownerUserId });
  }
  db.close();
  return dbPath;
}

describe('A2 cluster metrics in live verdict snapshot (Day-36 build)', () => {
  it('computes magic word cluster metrics from event-memory messageId grouping', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-cluster-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    seedRegistry(harnessFeedbackRoot);

    const baseMs = Date.now();
    const dbPath = join(root, 'task-outcome-episodes.sqlite');
    const store = new TaskOutcomeEpisodeStore(dbPath);

    // Episode 1: 1 magic word from message A
    const ep1 = store.createEpisode({ trigger: 'cat_initiated', threadId: 'thread-a', participants: ['codex-sol'] });
    store.appendSignal(ep1.episodeId, {
      category: 'a2',
      record: {
        type: 'magic_word_ref',
        eventId: 'evt_msg_a_word1',
        word: '补锅匠',
        timestamp: new Date(baseMs + 1000).toISOString(),
        threadId: 'thread-a',
        catId: 'codex-sol',
      },
      idempotencyKey: 'mwr:evt_msg_a_word1',
    });
    store.updateTerminalState(ep1.episodeId, 'completed');

    // Episode 2: 4 magic words from message B (one operator message with multiple magic words)
    const ep2 = store.createEpisode({ trigger: 'cat_initiated', threadId: 'thread-b', participants: ['fable-5'] });
    const msgBWords = ['第一性原理', '数学之美', '补锅匠', '喵约'];
    for (let i = 0; i < msgBWords.length; i++) {
      store.appendSignal(ep2.episodeId, {
        category: 'a2',
        record: {
          type: 'magic_word_ref',
          eventId: `evt_msg_b_word${i + 1}`,
          word: msgBWords[i],
          timestamp: new Date(baseMs + 5000 + i).toISOString(),
          threadId: 'thread-b',
          catId: 'fable-5',
        },
        idempotencyKey: `mwr:evt_msg_b_word${i + 1}`,
      });
    }
    // Also add a merge_success A1 to this episode
    store.appendSignal(ep2.episodeId, {
      category: 'a1',
      record: {
        type: 'merge_success',
        ref: 'pr-123',
        outcome: 'merged',
        timestamp: new Date(baseMs + 10000).toISOString(),
      },
    });
    store.updateTerminalState(ep2.episodeId, 'completed');

    // Seed event-memory: map eventIds to messageIds
    const ownerUserId = 'test-owner';
    const eventMemoryDbPath = seedEventMemoryDb(root, ownerUserId, [
      {
        eventId: 'evt_msg_a_word1',
        type: 'magic_word',
        trigger_type: 'auto',
        cat: 'codex-sol',
        threadId: 'thread-a',
        messageId: 'msg-a-001',
        timestamp: baseMs + 1000,
        summary: '补锅匠',
        confidence: 'high',
      },
      {
        eventId: 'evt_msg_b_word1',
        type: 'magic_word',
        trigger_type: 'auto',
        cat: 'fable-5',
        threadId: 'thread-b',
        messageId: 'msg-b-001',
        timestamp: baseMs + 5000,
        summary: '第一性原理',
        confidence: 'high',
      },
      {
        eventId: 'evt_msg_b_word2',
        type: 'magic_word',
        trigger_type: 'auto',
        cat: 'fable-5',
        threadId: 'thread-b',
        messageId: 'msg-b-001',
        timestamp: baseMs + 5001,
        summary: '数学之美',
        confidence: 'high',
      },
      {
        eventId: 'evt_msg_b_word3',
        type: 'magic_word',
        trigger_type: 'auto',
        cat: 'fable-5',
        threadId: 'thread-b',
        messageId: 'msg-b-001',
        timestamp: baseMs + 5002,
        summary: '补锅匠',
        confidence: 'high',
      },
      {
        eventId: 'evt_msg_b_word4',
        type: 'magic_word',
        trigger_type: 'auto',
        cat: 'fable-5',
        threadId: 'thread-b',
        messageId: 'msg-b-001',
        timestamp: baseMs + 5003,
        summary: '喵约',
        confidence: 'high',
      },
    ]);

    const sourceWindow = resolveTaskOutcomeSourceWindow(
      { kind: 'task-outcome-snapshot', windowStartMs: baseMs - 60_000, windowEndMs: baseMs + 60_000 },
      harnessFeedbackRoot,
      { defaultTaskOutcomeDbPath: dbPath, defaultEventMemoryDbPath: eventMemoryDbPath, ownerUserId },
    );

    // Pre-condition: 5 magic_word_ref signals, 5 event rows
    assert.equal(sourceWindow.signals.filter((s) => s.record.type === 'magic_word_ref').length, 5);
    assert.equal(sourceWindow.eventRows.length, 5);

    generateTaskOutcomeLiveVerdict({
      verdictId: '2026-07-16-cluster-test',
      harnessFeedbackRoot,
      domain,
      sourceWindow,
      submittedPacket: buildPacket({ id: '2026-07-16-cluster-test' }),
      generatedAt: '2026-07-16T03:30:00.000Z',
    });

    const snapshot = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', '2026-07-16-cluster-test', 'snapshot.json'), 'utf8'),
    );

    const comp = snapshot.components[0];

    // Existing frictionCounts unchanged
    assert.equal(comp.frictionCounts.magic_word_ref_total, 5, 'distinct eventIds = 5');

    // NEW: clusterMetrics
    assert.ok(comp.clusterMetrics, 'clusterMetrics must be present');
    assert.equal(
      comp.clusterMetrics.magicWordSourceMessages,
      2,
      'two distinct source messages (msg-a-001 and msg-b-001)',
    );
    assert.equal(comp.clusterMetrics.maxMagicWordsPerMessage, 4, 'msg-b-001 has 4 magic words');

    // P1-2: cluster-adjusted A2 total = magicWordSourceMessages + proposalRejectEpisodes + permissionCancel
    assert.equal(
      comp.clusterMetrics.clusterAdjustedA2Total,
      2,
      'cluster-adjusted A2 = 2 source messages + 0 episodes + 0 permission_cancel',
    );
  });

  it('computes proposal_reject cluster metrics by episode and proposalId', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-cluster-pr-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    seedRegistry(harnessFeedbackRoot);

    const baseMs = Date.now();
    const dbPath = join(root, 'task-outcome-episodes.sqlite');
    const store = new TaskOutcomeEpisodeStore(dbPath);

    // Episode with 2 proposal_reject signals (different proposalIds)
    const ep = store.createEpisode({ trigger: 'cat_initiated', threadId: 'thread-pr', participants: ['codex-sol'] });
    store.appendSignal(ep.episodeId, {
      category: 'a2',
      record: {
        type: 'proposal_reject',
        proposalId: 'proposal_aaa',
        proposalType: 'thread',
        catId: 'codex-sol',
        threadId: 'thread-pr',
        proposalTitle: 'Code as Harness Fix A',
        timestamp: new Date(baseMs + 1000).toISOString(),
      },
    });
    store.appendSignal(ep.episodeId, {
      category: 'a2',
      record: {
        type: 'proposal_reject',
        proposalId: 'proposal_bbb',
        proposalType: 'thread',
        catId: 'codex-sol',
        threadId: 'thread-pr',
        proposalTitle: 'Code as Harness Fix B',
        timestamp: new Date(baseMs + 2000).toISOString(),
      },
    });

    const sourceWindow = resolveTaskOutcomeSourceWindow(
      { kind: 'task-outcome-snapshot', windowStartMs: baseMs - 60_000, windowEndMs: baseMs + 60_000 },
      harnessFeedbackRoot,
      { defaultTaskOutcomeDbPath: dbPath, defaultEventMemoryDbPath: null },
    );

    assert.equal(sourceWindow.signals.filter((s) => s.record.type === 'proposal_reject').length, 2);

    generateTaskOutcomeLiveVerdict({
      verdictId: '2026-07-16-cluster-pr-test',
      harnessFeedbackRoot,
      domain,
      sourceWindow,
      submittedPacket: buildPacket({ id: '2026-07-16-cluster-pr-test' }),
      generatedAt: '2026-07-16T03:30:00.000Z',
    });

    const snapshot = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', '2026-07-16-cluster-pr-test', 'snapshot.json'), 'utf8'),
    );

    const comp = snapshot.components[0];
    assert.ok(comp.clusterMetrics, 'clusterMetrics must be present');
    assert.equal(comp.clusterMetrics.proposalRejectEpisodes, 1, 'both rejects in the same episode');
    assert.equal(comp.clusterMetrics.proposalRejectDistinctProposalIds, 2, 'two distinct proposalIds');
  });

  it('handles mixed A2 signals and computes combined cluster metrics', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-cluster-mixed-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    seedRegistry(harnessFeedbackRoot);

    const baseMs = Date.now();
    const dbPath = join(root, 'task-outcome-episodes.sqlite');
    const store = new TaskOutcomeEpisodeStore(dbPath);

    // Episode 1: magic words from one message
    const ep1 = store.createEpisode({ trigger: 'cat_initiated', threadId: 'thread-mx-a', participants: ['fable-5'] });
    store.appendSignal(ep1.episodeId, {
      category: 'a2',
      record: {
        type: 'magic_word_ref',
        eventId: 'evt_mx1',
        word: '脚手架',
        timestamp: new Date(baseMs + 1000).toISOString(),
        threadId: 'thread-mx-a',
        catId: 'fable-5',
      },
      idempotencyKey: 'mwr:evt_mx1',
    });
    store.appendSignal(ep1.episodeId, {
      category: 'a2',
      record: {
        type: 'magic_word_ref',
        eventId: 'evt_mx2',
        word: '绕路了',
        timestamp: new Date(baseMs + 1001).toISOString(),
        threadId: 'thread-mx-a',
        catId: 'fable-5',
      },
      idempotencyKey: 'mwr:evt_mx2',
    });
    store.updateTerminalState(ep1.episodeId, 'completed');

    // Episode 2: proposal rejects (different proposalIds, same episode)
    const ep2 = store.createEpisode({ trigger: 'cat_initiated', threadId: 'thread-mx-b', participants: ['sonnet'] });
    store.appendSignal(ep2.episodeId, {
      category: 'a2',
      record: {
        type: 'proposal_reject',
        proposalId: 'prop_x',
        proposalType: 'thread',
        catId: 'sonnet',
        threadId: 'thread-mx-b',
        timestamp: new Date(baseMs + 3000).toISOString(),
      },
    });
    store.appendSignal(ep2.episodeId, {
      category: 'a2',
      record: {
        type: 'proposal_reject',
        proposalId: 'prop_y',
        proposalType: 'thread',
        catId: 'sonnet',
        threadId: 'thread-mx-b',
        timestamp: new Date(baseMs + 4000).toISOString(),
      },
    });
    store.appendSignal(ep2.episodeId, {
      category: 'a2',
      record: {
        type: 'proposal_reject',
        proposalId: 'prop_x',
        proposalType: 'thread',
        catId: 'sonnet',
        threadId: 'thread-mx-b',
        timestamp: new Date(baseMs + 5000).toISOString(),
      },
    });

    // Episode 3: more proposal rejects (different episode)
    const ep3 = store.createEpisode({ trigger: 'cat_initiated', threadId: 'thread-mx-c', participants: ['opus'] });
    store.appendSignal(ep3.episodeId, {
      category: 'a2',
      record: {
        type: 'proposal_reject',
        proposalId: 'prop_z',
        proposalType: 'thread',
        catId: 'opus',
        threadId: 'thread-mx-c',
        timestamp: new Date(baseMs + 6000).toISOString(),
      },
    });

    // Seed event memory for magic words
    const ownerUserId = 'test-owner';
    const eventMemoryDbPath = seedEventMemoryDb(root, ownerUserId, [
      {
        eventId: 'evt_mx1',
        type: 'magic_word',
        trigger_type: 'auto',
        cat: 'fable-5',
        threadId: 'thread-mx-a',
        messageId: 'msg-mx-001',
        timestamp: baseMs + 1000,
        summary: '脚手架',
        confidence: 'high',
      },
      {
        eventId: 'evt_mx2',
        type: 'magic_word',
        trigger_type: 'auto',
        cat: 'fable-5',
        threadId: 'thread-mx-a',
        messageId: 'msg-mx-001',
        timestamp: baseMs + 1001,
        summary: '绕路了',
        confidence: 'high',
      },
    ]);

    const sourceWindow = resolveTaskOutcomeSourceWindow(
      { kind: 'task-outcome-snapshot', windowStartMs: baseMs - 60_000, windowEndMs: baseMs + 60_000 },
      harnessFeedbackRoot,
      { defaultTaskOutcomeDbPath: dbPath, defaultEventMemoryDbPath: eventMemoryDbPath, ownerUserId },
    );

    generateTaskOutcomeLiveVerdict({
      verdictId: '2026-07-16-cluster-mixed-test',
      harnessFeedbackRoot,
      domain,
      sourceWindow,
      submittedPacket: buildPacket({ id: '2026-07-16-cluster-mixed-test' }),
      generatedAt: '2026-07-16T03:30:00.000Z',
    });

    const snapshot = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', '2026-07-16-cluster-mixed-test', 'snapshot.json'), 'utf8'),
    );

    const comp = snapshot.components[0];
    assert.ok(comp.clusterMetrics, 'clusterMetrics must be present');

    // Magic word: 2 eventIds from 1 source message
    assert.equal(comp.clusterMetrics.magicWordSourceMessages, 1);
    assert.equal(comp.clusterMetrics.maxMagicWordsPerMessage, 2);

    // Proposal reject: 2 episodes, 3 distinct proposalIds (prop_x, prop_y, prop_z)
    assert.equal(comp.clusterMetrics.proposalRejectEpisodes, 2);
    assert.equal(comp.clusterMetrics.proposalRejectDistinctProposalIds, 3);

    // P1-2: cluster-adjusted A2 total
    assert.equal(
      comp.clusterMetrics.clusterAdjustedA2Total,
      3,
      'cluster-adjusted A2 = 1 source msg + 2 episodes + 0 permission_cancel',
    );
  });

  it('emits zero cluster metrics when no A2 signals exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-cluster-empty-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    seedRegistry(harnessFeedbackRoot);

    const baseMs = Date.now();
    const dbPath = join(root, 'task-outcome-episodes.sqlite');
    const store = new TaskOutcomeEpisodeStore(dbPath);

    // Episode with only A1 signals
    const ep = store.createEpisode({ trigger: 'cat_initiated', threadId: 'thread-empty', participants: ['opus'] });
    store.appendSignal(ep.episodeId, {
      category: 'a1',
      record: {
        type: 'merge_success',
        ref: 'pr-100',
        outcome: 'merged',
        timestamp: new Date(baseMs + 1000).toISOString(),
      },
    });
    store.updateTerminalState(ep.episodeId, 'completed');

    const sourceWindow = resolveTaskOutcomeSourceWindow(
      { kind: 'task-outcome-snapshot', windowStartMs: baseMs - 60_000, windowEndMs: baseMs + 60_000 },
      harnessFeedbackRoot,
      { defaultTaskOutcomeDbPath: dbPath, defaultEventMemoryDbPath: null },
    );

    generateTaskOutcomeLiveVerdict({
      verdictId: '2026-07-16-cluster-empty-test',
      harnessFeedbackRoot,
      domain,
      sourceWindow,
      submittedPacket: buildPacket({ id: '2026-07-16-cluster-empty-test' }),
      generatedAt: '2026-07-16T03:30:00.000Z',
    });

    const snapshot = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', '2026-07-16-cluster-empty-test', 'snapshot.json'), 'utf8'),
    );

    const comp = snapshot.components[0];
    assert.ok(comp.clusterMetrics, 'clusterMetrics must be present even with zero A2');
    assert.equal(comp.clusterMetrics.magicWordSourceMessages, 0);
    assert.equal(comp.clusterMetrics.maxMagicWordsPerMessage, 0);
    assert.equal(comp.clusterMetrics.proposalRejectEpisodes, 0);
    assert.equal(comp.clusterMetrics.proposalRejectDistinctProposalIds, 0);

    // P1-2: zero A2 → cluster-adjusted total = 0
    assert.equal(comp.clusterMetrics.clusterAdjustedA2Total, 0);
  });

  it('P1-1: same messageId across different threads counts as distinct sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'f192-cluster-collision-'));
    const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
    seedRegistry(harnessFeedbackRoot);

    const baseMs = Date.now();
    const dbPath = join(root, 'task-outcome-episodes.sqlite');
    const store = new TaskOutcomeEpisodeStore(dbPath);

    // Two magic words from different threads, SAME messageId
    const ep = store.createEpisode({ trigger: 'cat_initiated', threadId: 'thread-x', participants: ['opus'] });
    store.appendSignal(ep.episodeId, {
      category: 'a2',
      record: {
        type: 'magic_word_ref',
        eventId: 'evt_collision_1',
        word: '下次一定',
        timestamp: new Date(baseMs + 1000).toISOString(),
        threadId: 'thread-x',
        catId: 'opus',
      },
      idempotencyKey: 'mwr:evt_collision_1',
    });
    store.appendSignal(ep.episodeId, {
      category: 'a2',
      record: {
        type: 'magic_word_ref',
        eventId: 'evt_collision_2',
        word: '补锅匠',
        timestamp: new Date(baseMs + 2000).toISOString(),
        threadId: 'thread-y',
        catId: 'opus',
      },
      idempotencyKey: 'mwr:evt_collision_2',
    });
    store.updateTerminalState(ep.episodeId, 'completed');

    // Event memory: SAME messageId, DIFFERENT threadIds
    const ownerUserId = 'test-owner';
    const eventMemoryDbPath = seedEventMemoryDb(root, ownerUserId, [
      {
        eventId: 'evt_collision_1',
        type: 'magic_word',
        trigger_type: 'auto',
        cat: 'opus',
        threadId: 'thread-x',
        messageId: 'msg-same-id',
        timestamp: baseMs + 1000,
        summary: '下次一定',
        confidence: 'high',
      },
      {
        eventId: 'evt_collision_2',
        type: 'magic_word',
        trigger_type: 'auto',
        cat: 'opus',
        threadId: 'thread-y',
        messageId: 'msg-same-id',
        timestamp: baseMs + 2000,
        summary: '补锅匠',
        confidence: 'high',
      },
    ]);

    const sourceWindow = resolveTaskOutcomeSourceWindow(
      { kind: 'task-outcome-snapshot', windowStartMs: baseMs - 60_000, windowEndMs: baseMs + 60_000 },
      harnessFeedbackRoot,
      { defaultTaskOutcomeDbPath: dbPath, defaultEventMemoryDbPath: eventMemoryDbPath, ownerUserId },
    );

    generateTaskOutcomeLiveVerdict({
      verdictId: '2026-07-16-cluster-collision-test',
      harnessFeedbackRoot,
      domain,
      sourceWindow,
      submittedPacket: buildPacket({ id: '2026-07-16-cluster-collision-test' }),
      generatedAt: '2026-07-16T03:30:00.000Z',
    });

    const snapshot = JSON.parse(
      readFileSync(join(harnessFeedbackRoot, 'bundles', '2026-07-16-cluster-collision-test', 'snapshot.json'), 'utf8'),
    );

    const comp = snapshot.components[0];
    // P1-1: composite (threadId:messageId) key → 2 distinct sources, not 1
    assert.equal(
      comp.clusterMetrics.magicWordSourceMessages,
      2,
      'same messageId in different threads = 2 distinct sources (not 1)',
    );
    assert.equal(comp.clusterMetrics.maxMagicWordsPerMessage, 1, 'each thread:messageId has 1 magic word');
    assert.equal(comp.clusterMetrics.clusterAdjustedA2Total, 2);
  });
});
