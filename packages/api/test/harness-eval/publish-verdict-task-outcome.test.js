import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { EventMemoryStore } from '../../dist/domains/memory/EventMemoryStore.js';
import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { createTaskOutcomeGeneratorAdapter } from '../../dist/infrastructure/harness-eval/publish-verdict/task-outcome-generator-adapter.js';
import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

const root = mkdtempSync(join(tmpdir(), 'publish-verdict-taskoutcome-'));
const harnessFeedbackRoot = join(root, 'docs/harness-feedback');
let baseMs = Date.now();

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

async function seedWindow(taskOutcomeDbPath = join(root, 'task-outcome-episodes.sqlite')) {
  baseMs = Date.now();
  const store = new TaskOutcomeEpisodeStore(taskOutcomeDbPath);
  const ep = store.createEpisode({
    trigger: 'cat_initiated',
    threadId: 'thread-task',
    participants: ['gpt52'],
  });
  store.appendSignal(ep.episodeId, {
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
  store.updateTerminalState(ep.episodeId, 'completed');

  const eventStore = new EventMemoryStore(join(root, 'event-memory.sqlite'));
  await eventStore.initialize();
  eventStore.markEvent(
    {
      type: 'magic_word',
      trigger: 'human_brake',
      cat: 'gpt52',
      threadId: 'thread-task',
      messageId: 'msg-1',
      timestamp: baseMs + 2_000,
      summary: '用户拉闸',
      cognitiveTransition: 'user_brake',
      relatedHarness: ['F227'],
      confidence: 'high',
    },
    'you',
  );
  return { baseMs, episodeId: ep.episodeId, taskOutcomeDbPath };
}

function buildPacket(overrides = {}) {
  return {
    id: 'vhp-task-outcome-e2e-test',
    domainId: 'eval:task-outcome',
    createdAt: '2026-06-09T03:30:00.000Z',
    phenomenon: 'task outcome e2e test',
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
    ...overrides,
  };
}

function buildMockArtifactPublisher(isoName, artifactId, artifactUrl) {
  return {
    async publishArtifact({ packet, generate }) {
      const iso = mkdtempSync(join(root, `${isoName}-`));
      try {
        const outputRoot = join(iso, 'docs', 'harness-feedback');
        mkdirSync(join(outputRoot, 'eval-domains'), { recursive: true });
        writeFileSync(
          join(outputRoot, 'eval-domains', 'eval-task-outcome.yaml'),
          readFileSync(join(harnessFeedbackRoot, 'eval-domains', 'eval-task-outcome.yaml'), 'utf8'),
        );
        const generated = await generate(outputRoot);
        await generated.afterPublish?.();
        return {
          artifactId,
          domainSlug: packet.domainId.replace(/:/g, '-'),
          verdictPath: generated.verdictPath,
          bundleDir: generated.bundleDir,
          artifactUrl,
        };
      } finally {
        rmSync(iso, { recursive: true, force: true });
      }
    },
  };
}

before(async () => {
  seedRegistryAndDirs();
  await seedWindow();
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('handlePublishVerdict end-to-end with task-outcome generator', () => {
  it('happy path: handler dispatches to task-outcome adapter and returns repo-relative verdict paths', async () => {
    const generator = createTaskOutcomeGeneratorAdapter();
    const artifactPublisher = buildMockArtifactPublisher(
      'task-outcome-e2e-iso',
      'task-sha-1234',
      'artifact://eval-task-outcome/task-artifact-1234',
    );

    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: harnessFeedbackRoot, artifactPublisher, generator },
      {
        packet: buildPacket(),
        domain: 'eval:task-outcome',
        catId: 'opus-47',
        ownerUserId: 'you',
        sourceRefs: {
          kind: 'task-outcome-snapshot',
          windowStartMs: baseMs - 60_000,
          windowEndMs: baseMs + 60_000,
        },
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.artifactId, 'task-sha-1234');
    assert.equal(result.artifactUrl, 'artifact://eval-task-outcome/task-artifact-1234');
    // F257 / F192 sunset: ArtifactPublisher returns absolute store paths; assert suffix.
    assert.match(result.verdictPath, /verdicts\/vhp-task-outcome-e2e-test\.md$/);
    assert.match(result.bundleDir, /bundles\/vhp-task-outcome-e2e-test$/);
  });

  it('uses runtime-configured taskOutcomeDbPath when sourceRefs omit databasePath', async () => {
    const customTaskOutcomeDbPath = join(tmpdir(), `publish-verdict-taskoutcome-custom-${Date.now()}.sqlite`);
    await seedWindow(customTaskOutcomeDbPath);
    const generator = createTaskOutcomeGeneratorAdapter();
    const artifactPublisher = buildMockArtifactPublisher(
      'task-outcome-configured-db-iso',
      'task-sha-5678',
      'artifact://eval-task-outcome/task-artifact-5678',
    );

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: harnessFeedbackRoot,
        artifactPublisher,
        generator,
        taskOutcomeDbPath: customTaskOutcomeDbPath,
      },
      {
        packet: buildPacket({ id: 'vhp-task-outcome-e2e-configured-db' }),
        domain: 'eval:task-outcome',
        catId: 'opus-47',
        ownerUserId: 'you',
        sourceRefs: {
          kind: 'task-outcome-snapshot',
          windowStartMs: baseMs - 60_000,
          windowEndMs: baseMs + 60_000,
        },
      },
    );

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.artifactId, 'task-sha-5678');
  });

  it('writes explicit 7-class episode verdicts back to the task-outcome DB', async () => {
    const customTaskOutcomeDbPath = join(tmpdir(), `publish-verdict-taskoutcome-writeback-${Date.now()}.sqlite`);
    const seeded = await seedWindow(customTaskOutcomeDbPath);
    const generator = createTaskOutcomeGeneratorAdapter();
    const artifactPublisher = buildMockArtifactPublisher(
      'task-outcome-writeback-iso',
      'task-sha-writeback',
      'artifact://eval-task-outcome/task-artifact-writeback',
    );

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: harnessFeedbackRoot,
        artifactPublisher,
        generator,
        taskOutcomeDbPath: customTaskOutcomeDbPath,
      },
      {
        packet: buildPacket({ id: 'vhp-task-outcome-e2e-writeback' }),
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

    assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
    assert.equal(result.artifactId, 'task-sha-writeback');

    const store = new TaskOutcomeEpisodeStore(customTaskOutcomeDbPath);
    assert.equal(store.getEpisode(seeded.episodeId)?.verdict, 'corrected_success');
    assert.equal(
      store.listNeedingVerdict().some((episode) => episode.episodeId === seeded.episodeId),
      false,
      'written-back episode should no longer appear in needingVerdict',
    );
  });

  it('does not write episode verdicts when publish fails after staging', async () => {
    const customTaskOutcomeDbPath = join(tmpdir(), `publish-verdict-taskoutcome-publish-fail-${Date.now()}.sqlite`);
    const seeded = await seedWindow(customTaskOutcomeDbPath);
    const generator = createTaskOutcomeGeneratorAdapter();
    const failingArtifactPublisher = {
      async publishArtifact({ generate }) {
        const iso = mkdtempSync(join(root, 'task-outcome-writeback-publish-fail-iso-'));
        try {
          const outputRoot = join(iso, 'docs', 'harness-feedback');
          mkdirSync(join(outputRoot, 'eval-domains'), { recursive: true });
          writeFileSync(
            join(outputRoot, 'eval-domains', 'eval-task-outcome.yaml'),
            readFileSync(join(harnessFeedbackRoot, 'eval-domains', 'eval-task-outcome.yaml'), 'utf8'),
          );
          await generate(outputRoot);
          throw new Error('simulated artifact publish failure');
        } finally {
          rmSync(iso, { recursive: true, force: true });
        }
      },
    };
    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot,
        artifactPublisher: failingArtifactPublisher,
        generator,
        taskOutcomeDbPath: customTaskOutcomeDbPath,
      },
      {
        packet: buildPacket({ id: 'vhp-task-outcome-e2e-writeback-publish-fail' }),
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

    const store = new TaskOutcomeEpisodeStore(customTaskOutcomeDbPath);
    assert.equal(result.status, 500);
    assert.equal(result.error, 'publisher_failed');
    assert.equal(store.getEpisode(seeded.episodeId)?.verdict, null);
  });

  it('rejects episode verdict writeback for non-terminal episodes', async () => {
    const customTaskOutcomeDbPath = join(tmpdir(), `publish-verdict-taskoutcome-in-progress-${Date.now()}.sqlite`);
    const seeded = await seedWindow(customTaskOutcomeDbPath);
    const invalidVerdictId = `vhp-task-outcome-e2e-writeback-invalid-${Math.random().toString(36).slice(2, 8)}`;
    const store = new TaskOutcomeEpisodeStore(customTaskOutcomeDbPath);
    const activeEpisode = store.createEpisode({
      trigger: 'cat_initiated',
      threadId: 'thread-task',
      participants: ['gpt52'],
    });
    const generator = createTaskOutcomeGeneratorAdapter();
    const artifactPublisher = buildMockArtifactPublisher(
      'task-outcome-writeback-invalid-iso',
      'unreachable',
      'artifact://eval-task-outcome/task-artifact-invalid-terminal',
    );

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: harnessFeedbackRoot,
        artifactPublisher,
        generator,
        taskOutcomeDbPath: customTaskOutcomeDbPath,
      },
      {
        packet: buildPacket({ id: invalidVerdictId }),
        domain: 'eval:task-outcome',
        catId: 'opus-47',
        ownerUserId: 'you',
        sourceRefs: {
          kind: 'task-outcome-snapshot',
          windowStartMs: seeded.baseMs - 60_000,
          windowEndMs: seeded.baseMs + 60_000,
          episodeVerdicts: [{ episodeId: activeEpisode.episodeId, verdict: 'success' }],
        },
      },
    );

    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_episode_verdict_writeback');
    assert.match(result.detail, /terminalState='in_progress'/);
    assert.equal(store.getEpisode(activeEpisode.episodeId)?.verdict, null);
  });

  it('rejects episode verdict writeback for episodes outside the selected window', async () => {
    const customTaskOutcomeDbPath = join(tmpdir(), `publish-verdict-taskoutcome-outside-${Date.now()}.sqlite`);
    const seeded = await seedWindow(customTaskOutcomeDbPath);
    const invalidVerdictId = `vhp-task-outcome-e2e-writeback-outside-${Math.random().toString(36).slice(2, 8)}`;
    const generator = createTaskOutcomeGeneratorAdapter();
    const artifactPublisher = buildMockArtifactPublisher(
      'task-outcome-writeback-outside-iso',
      'unreachable',
      'artifact://eval-task-outcome/task-artifact-outside-window',
    );

    const result = await handlePublishVerdict(
      {
        harnessFeedbackRoot: harnessFeedbackRoot,
        artifactPublisher,
        generator,
        taskOutcomeDbPath: customTaskOutcomeDbPath,
      },
      {
        packet: buildPacket({ id: invalidVerdictId }),
        domain: 'eval:task-outcome',
        catId: 'opus-47',
        ownerUserId: 'you',
        sourceRefs: {
          kind: 'task-outcome-snapshot',
          windowStartMs: seeded.baseMs - 120_000,
          windowEndMs: seeded.baseMs - 60_000,
          episodeVerdicts: [{ episodeId: seeded.episodeId, verdict: 'success' }],
        },
      },
    );

    const store = new TaskOutcomeEpisodeStore(customTaskOutcomeDbPath);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_episode_verdict_writeback');
    assert.match(result.detail, /is not in the selected task-outcome window/);
    assert.equal(store.getEpisode(seeded.episodeId)?.verdict, null);
  });
});
