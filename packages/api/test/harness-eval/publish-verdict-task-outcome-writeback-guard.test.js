import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { createTaskOutcomeGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/task-outcome-generator-adapter.js';
import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

const root = mkdtempSync(join(tmpdir(), 'publish-verdict-taskoutcome-guard-'));
const harnessFeedbackRoot = join(root, 'docs/harness-feedback');

function seedRegistryAndDirs() {
  const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
  mkdirSync(domainsDir, { recursive: true });
  writeFileSync(
    join(domainsDir, 'eval-task-outcome.yaml'),
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
  allowedContent: [longitudinal-analysis, verdict-discussion, handoff-drafts]
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
  mkdirSync(join(harnessFeedbackRoot, 'verdicts'), { recursive: true });
  mkdirSync(join(harnessFeedbackRoot, 'bundles'), { recursive: true });
}

function seedTerminalEpisode(taskOutcomeDbPath, verdict = null) {
  const baseMs = Date.now();
  const store = new TaskOutcomeEpisodeStore(taskOutcomeDbPath);
  const episode = store.createEpisode({
    trigger: 'cat_initiated',
    threadId: 'thread-task',
    participants: ['gpt52'],
  });
  store.appendSignal(episode.episodeId, {
    category: 'a2',
    record: {
      type: 'proposal_reject',
      proposalId: 'prop-1',
      proposalType: 'thread',
      catId: 'gpt52',
      threadId: 'thread-task',
      timestamp: new Date(baseMs + 1_000).toISOString(),
    },
  });
  store.updateTerminalState(episode.episodeId, 'completed');
  if (verdict !== null) store.updateVerdict(episode.episodeId, verdict);
  return { baseMs, episodeId: episode.episodeId };
}

function buildPacket(id) {
  return {
    id,
    domainId: 'eval:task-outcome',
    createdAt: '2026-06-09T03:30:00.000Z',
    phenomenon: 'task outcome already verdicted writeback guard',
    harnessUnderEval: { featureId: 'F192', componentId: 'Phase-G-v0', name: 'task-outcome eval pipeline' },
    evidencePacket: {
      snapshotRefs: ['placeholder:overridden'],
      attributionRefs: ['placeholder:overridden'],
      metricRefs: ['metric:task_outcome.episodes_total'],
      sampleTraceRefs: ['thread:thread-task'],
    },
    dailyTrend: { window: '24h', current: { a: 1 }, baseline: { a: 1 }, threshold: { a: 5 }, direction: 'flat' },
    rootCauseHypothesis: { summary: 'task outcome', confidence: 'medium', alternatives: ['alt'] },
    verdict: 'keep_observe',
    ownerAsk: { targetFeatureId: 'F192', targetOwnerCatId: 'opus', requestedAction: 'observe' },
    acceptanceReevalPlan: { nextEvalAt: '2026-06-10T03:00:00.000Z', closureCondition: 'stable' },
    counterarguments: ['none'],
  };
}

function buildMockGitPublisher() {
  return {
    async publishOnIsolatedWorktree(opts) {
      const iso = join(root, '..', `task-outcome-writeback-guard-iso-${Date.now()}`);
      mkdirSync(join(iso, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
      writeFileSync(
        join(iso, 'docs', 'harness-feedback', 'eval-domains', 'eval-task-outcome.yaml'),
        readFileSync(join(harnessFeedbackRoot, 'eval-domains', 'eval-task-outcome.yaml'), 'utf8'),
      );
      try {
        const stageResult = await opts.stage(iso);
        await stageResult.afterPublish?.();
        return { commitSha: 'unreachable', prUrl: 'https://github.com/zts212653/clowder-ai/pull/9006' };
      } finally {
        rmSync(iso, { recursive: true, force: true });
      }
    },
  };
}

before(seedRegistryAndDirs);

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('task-outcome episode verdict writeback guards', () => {
  it('rejects writebacks for already-verdicted episodes without overwriting the stored verdict', async () => {
    const taskOutcomeDbPath = join(tmpdir(), `publish-verdict-taskoutcome-already-${Date.now()}.sqlite`);
    const seeded = seedTerminalEpisode(taskOutcomeDbPath, 'success');
    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot,
        gitPublisher: buildMockGitPublisher(),
        generator: createTaskOutcomeGeneratorAdapter(),
        taskOutcomeDbPath,
      },
      {
        packet: buildPacket('vhp-task-outcome-e2e-writeback-already-verdicted'),
        domain: 'eval:task-outcome',
        catId: 'opus-47',
        ownerUserId: 'you',
        sourceRefs: {
          kind: 'task-outcome-snapshot',
          windowStartMs: seeded.baseMs - 60_000,
          windowEndMs: seeded.baseMs + 60_000,
          episodeVerdicts: [{ episodeId: seeded.episodeId, verdict: 'corrected_success' }],
        },
      },
    );

    const store = new TaskOutcomeEpisodeStore(taskOutcomeDbPath);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_episode_verdict_writeback');
    assert.match(result.detail, /already has verdict='success'/);
    assert.equal(store.getEpisode(seeded.episodeId)?.verdict, 'success');
  });

  it('does not expose a verdict PR when the final writeback claim fails', async () => {
    const taskOutcomeDbPath = join(tmpdir(), `publish-verdict-taskoutcome-stale-pr-${Date.now()}.sqlite`);
    const seeded = seedTerminalEpisode(taskOutcomeDbPath);
    let exposedPr = false;
    const gitPublisher = {
      async publishOnIsolatedWorktree(opts) {
        const iso = join(root, '..', `task-outcome-writeback-stale-pr-iso-${Date.now()}`);
        mkdirSync(join(iso, 'docs', 'harness-feedback', 'eval-domains'), { recursive: true });
        writeFileSync(
          join(iso, 'docs', 'harness-feedback', 'eval-domains', 'eval-task-outcome.yaml'),
          readFileSync(join(harnessFeedbackRoot, 'eval-domains', 'eval-task-outcome.yaml'), 'utf8'),
        );
        try {
          const stageResult = await opts.stage(iso);
          new TaskOutcomeEpisodeStore(taskOutcomeDbPath).updateVerdict(seeded.episodeId, 'success');
          await stageResult.afterPublish?.();
          exposedPr = true;
          return { commitSha: 'unreachable', prUrl: 'https://github.com/zts212653/clowder-ai/pull/9007' };
        } finally {
          rmSync(iso, { recursive: true, force: true });
        }
      },
    };
    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot,
        gitPublisher,
        generator: createTaskOutcomeGeneratorAdapter(),
        taskOutcomeDbPath,
      },
      {
        packet: buildPacket('vhp-task-outcome-e2e-writeback-stale-pr'),
        domain: 'eval:task-outcome',
        catId: 'opus-47',
        ownerUserId: 'you',
        sourceRefs: {
          kind: 'task-outcome-snapshot',
          windowStartMs: seeded.baseMs - 60_000,
          windowEndMs: seeded.baseMs + 60_000,
          episodeVerdicts: [{ episodeId: seeded.episodeId, verdict: 'corrected_success' }],
        },
      },
    );

    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_episode_verdict_writeback');
    assert.match(result.detail, /already has verdict='success'/);
    assert.equal(exposedPr, false);
  });

  it('rejects stale concurrent writeback callbacks without overwriting the first verdict', async () => {
    const taskOutcomeDbPath = join(tmpdir(), `publish-verdict-taskoutcome-concurrent-${Date.now()}.sqlite`);
    const seeded = seedTerminalEpisode(taskOutcomeDbPath);
    const generator = createTaskOutcomeGeneratorAdapter();
    const deps = {
      harnessFeedbackRoot,
      liveHarnessFeedbackRoot: harnessFeedbackRoot,
      ownerUserId: 'you',
      taskOutcomeDbPath,
    };
    const sourceRefs = {
      kind: 'task-outcome-snapshot',
      windowStartMs: seeded.baseMs - 60_000,
      windowEndMs: seeded.baseMs + 60_000,
    };
    const first = await generator(
      buildPacket('vhp-task-outcome-concurrent-first'),
      {
        ...sourceRefs,
        episodeVerdicts: [{ episodeId: seeded.episodeId, verdict: 'success' }],
      },
      deps,
    );
    const second = await generator(
      buildPacket('vhp-task-outcome-concurrent-second'),
      {
        ...sourceRefs,
        episodeVerdicts: [{ episodeId: seeded.episodeId, verdict: 'corrected_success' }],
      },
      deps,
    );
    const store = new TaskOutcomeEpisodeStore(taskOutcomeDbPath);

    first.afterPublish?.();
    assert.equal(store.getEpisode(seeded.episodeId)?.verdict, 'success');
    await assert.rejects(async () => second.afterPublish?.(), /already has verdict='success'/);
    assert.equal(store.getEpisode(seeded.episodeId)?.verdict, 'success');
  });

  it('rolls back earlier episode writebacks when a later episode is claimed concurrently', async () => {
    const taskOutcomeDbPath = join(tmpdir(), `publish-verdict-taskoutcome-batch-${Date.now()}.sqlite`);
    const firstSeeded = seedTerminalEpisode(taskOutcomeDbPath);
    const secondSeeded = seedTerminalEpisode(taskOutcomeDbPath);
    const generator = createTaskOutcomeGeneratorAdapter();
    const deps = {
      harnessFeedbackRoot,
      liveHarnessFeedbackRoot: harnessFeedbackRoot,
      ownerUserId: 'you',
      taskOutcomeDbPath,
    };
    const artifact = await generator(
      buildPacket('vhp-task-outcome-concurrent-batch'),
      {
        kind: 'task-outcome-snapshot',
        windowStartMs: Math.min(firstSeeded.baseMs, secondSeeded.baseMs) - 60_000,
        windowEndMs: Math.max(firstSeeded.baseMs, secondSeeded.baseMs) + 60_000,
        episodeVerdicts: [
          { episodeId: firstSeeded.episodeId, verdict: 'success' },
          { episodeId: secondSeeded.episodeId, verdict: 'corrected_success' },
        ],
      },
      deps,
    );
    const store = new TaskOutcomeEpisodeStore(taskOutcomeDbPath);

    store.updateVerdict(secondSeeded.episodeId, 'needs_investigation');
    await assert.rejects(async () => artifact.afterPublish?.(), /already has verdict='needs_investigation'/);
    assert.equal(store.getEpisode(firstSeeded.episodeId)?.verdict, null);
    assert.equal(store.getEpisode(secondSeeded.episodeId)?.verdict, 'needs_investigation');
  });
});
