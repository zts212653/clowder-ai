// @ts-check
/**
 * F202 Phase 2B: GitHub Schedule Factories — unit + integration tests
 *
 * Covers:
 * - plugin.yaml manifest parsing (AC-B1)
 * - Factory registration + task creation with custom instanceId
 * - repo-scan missing deps validation
 * - Full enable/disable lifecycle via PluginResourceActivator (AC-B4)
 * - Rehydration of GitHub schedule resources on startup (AC-B4)
 * - Custom ID propagation to existing TaskSpec factories
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Phase B imports
import { registerGitHubScheduleFactories } from '../dist/domains/plugin/github-schedule-factories.js';
// Manifest parser
import { parsePluginManifest } from '../dist/domains/plugin/plugin-manifest.js';
// Phase A imports
import { ScheduleFactoryRegistry } from '../dist/domains/plugin/ScheduleFactoryRegistry.js';
import { createRepoScanTaskSpec } from '../dist/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js';
// TaskSpec factories (for custom id tests)
import { createCiCdCheckTaskSpec } from '../dist/infrastructure/email/CiCdCheckTaskSpec.js';
import { createConflictCheckTaskSpec } from '../dist/infrastructure/email/ConflictCheckTaskSpec.js';
import { createReviewFeedbackTaskSpec } from '../dist/infrastructure/email/ReviewFeedbackTaskSpec.js';

const stubLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
};

const stubTaskStore = {
  listByKind: async () => [],
  patchAutomationState: async () => {},
};

const stubRouter = { route: async () => ({ kind: 'skipped' }) };

/** Minimal ScheduleFactoryDeps bag for GitHub factories */
function makeGitHubDeps(overrides = {}) {
  return {
    log: stubLog,
    taskStore: stubTaskStore,
    cicdRouter: stubRouter,
    conflictRouter: stubRouter,
    reviewFeedbackRouter: stubRouter,
    invokeTrigger: { trigger: () => 'dispatched' },
    checkMergeable: async () => ({ mergeState: 'MERGEABLE', headSha: 'abc123' }),
    autoExecutor: { execute: async () => {} },
    fetchPrMetadata: async () => ({ headSha: 'abc', prState: 'open' }),
    fetchComments: async () => [],
    fetchReviews: async () => [],
    isEchoComment: () => false,
    isEchoReview: () => false,
    isNoiseComment: () => false,
    // repo-scan deps
    repoAllowlist: ['owner/repo'],
    inboxCatId: 'cat-1',
    defaultUserId: 'user-1',
    reconciliationDedup: {
      isNotified: async () => false,
      markNotified: async () => {},
      isBaselineEstablished: async () => true,
      markBaselineEstablished: async () => {},
    },
    bindingStore: { getByExternal: async () => null },
    deliverFn: async () => ({ status: 'delivered', threadId: 't1' }),
    deliveryDeps: { messageStore: {}, socketManager: {} },
    fetchOpenPRs: async () => [],
    fetchOpenIssues: async () => [],
    // F202 Phase 2D: issue-tracking deps
    issueCommentRouter: stubRouter,
    fetchIssueComments: async () => [],
    fetchIssueState: async () => 'open',
    isEchoIssueComment: () => false,
    // F168 C0.3: repo-comment-poll deps (collection-only, redis-gated like repo-scan)
    eventLog: {
      append: async () => ({ appended: true, sequence: 0 }),
      read: async () => [],
      listSubjects: async () => [],
    },
    fetchRepoComments: async () => [],
    readRepoCommentCursor: async () => undefined,
    writeRepoCommentCursor: async () => {},
    ...overrides,
  };
}

// --- Task 1: Custom ID propagation ---

describe('TaskSpec factory custom id (F202-2B Task 1)', () => {
  test('createCiCdCheckTaskSpec uses custom id when provided', () => {
    const spec = createCiCdCheckTaskSpec({
      taskStore: stubTaskStore,
      cicdRouter: stubRouter,
      log: stubLog,
      id: 'schedule:github:cicd-check',
    });
    assert.strictEqual(spec.id, 'schedule:github:cicd-check');
  });

  test('createCiCdCheckTaskSpec defaults to cicd-check when id omitted', () => {
    const spec = createCiCdCheckTaskSpec({
      taskStore: stubTaskStore,
      cicdRouter: stubRouter,
      log: stubLog,
    });
    assert.strictEqual(spec.id, 'cicd-check');
  });

  test('createConflictCheckTaskSpec uses custom id when provided', () => {
    const spec = createConflictCheckTaskSpec({
      taskStore: stubTaskStore,
      checkMergeable: async () => ({ mergeState: 'MERGEABLE', headSha: 'abc' }),
      conflictRouter: stubRouter,
      log: stubLog,
      id: 'schedule:github:conflict-check',
    });
    assert.strictEqual(spec.id, 'schedule:github:conflict-check');
  });

  test('createReviewFeedbackTaskSpec uses custom id when provided', () => {
    const spec = createReviewFeedbackTaskSpec({
      taskStore: stubTaskStore,
      fetchComments: async () => [],
      fetchReviews: async () => [],
      reviewFeedbackRouter: stubRouter,
      log: stubLog,
      id: 'schedule:github:review-feedback',
    });
    assert.strictEqual(spec.id, 'schedule:github:review-feedback');
  });

  test('createRepoScanTaskSpec uses custom id when provided', () => {
    const spec = createRepoScanTaskSpec({
      repoAllowlist: ['owner/repo'],
      inboxCatId: 'cat-1',
      defaultUserId: 'user-1',
      reconciliationDedup: {
        isNotified: async () => false,
        markNotified: async () => {},
        isBaselineEstablished: async () => true,
        markBaselineEstablished: async () => {},
      },
      bindingStore: { getByExternal: async () => null },
      deliverFn: async () => ({ status: 'delivered', threadId: 't1' }),
      deliveryDeps: { messageStore: {}, socketManager: {} },
      invokeTrigger: { trigger: () => {} },
      fetchOpenPRs: async () => [],
      fetchOpenIssues: async () => [],
      log: stubLog,
      id: 'schedule:github:repo-scan',
    });
    assert.strictEqual(spec.id, 'schedule:github:repo-scan');
  });
});

// --- P2-2: Schedule name backslash validation ---

describe('schedule name validation (P2-2)', () => {
  test('parsePluginManifest rejects schedule name containing backslash', () => {
    const tmpDir = join(__dirname, `tmp-backslash-${Date.now()}`);
    mkdirSync(join(tmpDir, 'test-bs'), { recursive: true });
    const yamlPath = join(tmpDir, 'test-bs', 'plugin.yaml');
    writeFileSync(
      yamlPath,
      [
        'id: test-bs',
        'name: Test Backslash',
        'version: 1.0.0',
        'resources:',
        '  - type: schedule',
        '    name: "bad\\\\name"',
        '    factoryId: test.factory',
      ].join('\n'),
    );
    try {
      assert.throws(() => parsePluginManifest(yamlPath), /backslash/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('parsePluginManifest accepts schedule name without backslash', () => {
    const tmpDir = join(__dirname, `tmp-good-name-${Date.now()}`);
    mkdirSync(join(tmpDir, 'test-ok'), { recursive: true });
    const yamlPath = join(tmpDir, 'test-ok', 'plugin.yaml');
    writeFileSync(
      yamlPath,
      [
        'id: test-ok',
        'name: Test OK',
        'version: 1.0.0',
        'resources:',
        '  - type: schedule',
        '    name: "cicd-check"',
        '    factoryId: test.factory',
      ].join('\n'),
    );
    try {
      const manifest = parsePluginManifest(yamlPath);
      assert.strictEqual(manifest.resources[0].name, 'cicd-check');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --- Task 2: plugin.yaml manifest parsing ---

describe('plugins/github/plugin.yaml (AC-B1)', () => {
  test('parses as valid PluginManifest with 3 config + 6 schedule resources', () => {
    const yamlPath = join(__dirname, '../../../plugins/github/plugin.yaml');
    assert.ok(existsSync(yamlPath), `plugin.yaml must exist at ${yamlPath}`);

    const manifest = parsePluginManifest(yamlPath);
    assert.strictEqual(manifest.id, 'github');
    assert.strictEqual(manifest.name, 'GitHub');
    assert.strictEqual(manifest.version, '1.0.0');

    // Config fields
    assert.strictEqual(manifest.config.length, 3);
    const envNames = manifest.config.map((c) => c.envName);
    assert.ok(envNames.includes('GITHUB_TOKEN'));
    assert.ok(envNames.includes('GITHUB_SETUP_NOISE_BOT_LOGINS'));
    assert.ok(envNames.includes('GITHUB_MCP_PAT'));

    // GitHub pollers use the system gh CLI auth store; token config is optional.
    const tokenField = manifest.config.find((c) => c.envName === 'GITHUB_TOKEN');
    assert.strictEqual(tokenField?.required, false);
    assert.strictEqual(tokenField?.sensitive, true);

    const noiseField = manifest.config.find((c) => c.envName === 'GITHUB_SETUP_NOISE_BOT_LOGINS');
    assert.strictEqual(noiseField?.required, false);

    // Schedule resources (4 original + issue-tracking F202-2D + repo-comment-poll F168-C0.3)
    assert.strictEqual(manifest.resources.length, 6);
    for (const r of manifest.resources) {
      assert.strictEqual(r.type, 'schedule');
      assert.ok(r.factoryId?.startsWith('github.'), `factoryId must start with "github.": ${r.factoryId}`);
      assert.ok(r.name, `schedule resource must have a name`);
    }

    const resourceNames = manifest.resources.map((r) => r.name).sort();
    assert.deepStrictEqual(resourceNames, [
      'cicd-check',
      'conflict-check',
      'issue-tracking',
      'repo-comment-poll',
      'repo-scan',
      'review-feedback',
    ]);
  });
});

// --- Task 3: Factory registration + task creation ---

describe('GitHub schedule factory registration (F202-2B Task 3)', () => {
  test('registerGitHubScheduleFactories registers all 6 factories', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    assert.ok(registry.has('github.cicd-check'));
    assert.ok(registry.has('github.conflict-check'));
    assert.ok(registry.has('github.review-feedback'));
    assert.ok(registry.has('github.repo-scan'));
    assert.ok(registry.has('github.issue-tracking'));
    assert.ok(registry.has('github.repo-comment-poll'));
  });

  test('github.cicd-check factory creates TaskSpec with correct instanceId', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.cicd-check');
    assert.ok(factory);
    const spec = factory.createTaskSpec('schedule:github:cicd-check', makeGitHubDeps());
    assert.strictEqual(spec.id, 'schedule:github:cicd-check');
    assert.strictEqual(spec.profile, 'poller');
  });

  test('github.conflict-check factory creates TaskSpec with correct instanceId', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.conflict-check');
    assert.ok(factory);
    const spec = factory.createTaskSpec('schedule:github:conflict-check', makeGitHubDeps());
    assert.strictEqual(spec.id, 'schedule:github:conflict-check');
    assert.strictEqual(spec.profile, 'poller');
  });

  test('github.review-feedback factory creates TaskSpec with correct instanceId', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.review-feedback');
    assert.ok(factory);
    const spec = factory.createTaskSpec('schedule:github:review-feedback', makeGitHubDeps());
    assert.strictEqual(spec.id, 'schedule:github:review-feedback');
    assert.strictEqual(spec.profile, 'poller');
  });

  test('github.repo-scan factory creates TaskSpec with correct instanceId', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-scan');
    assert.ok(factory);
    const spec = factory.createTaskSpec('schedule:github:repo-scan', makeGitHubDeps());
    assert.strictEqual(spec.id, 'schedule:github:repo-scan');
    assert.strictEqual(spec.profile, 'poller');
  });

  test('github.repo-scan factory throws when repoAllowlist missing', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-scan');
    assert.ok(factory);
    const deps = makeGitHubDeps({ repoAllowlist: undefined });
    assert.throws(() => factory.createTaskSpec('schedule:github:repo-scan', deps), /repoAllowlist/);
  });

  test('github.repo-scan factory throws when redis deps missing', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-scan');
    assert.ok(factory);
    const deps = makeGitHubDeps({ reconciliationDedup: undefined });
    assert.throws(() => factory.createTaskSpec('schedule:github:repo-scan', deps), /reconciliationDedup/);
  });

  test('github.issue-tracking factory creates TaskSpec with correct instanceId', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.issue-tracking');
    assert.ok(factory);
    const spec = factory.createTaskSpec('schedule:github:issue-tracking', makeGitHubDeps());
    assert.strictEqual(spec.id, 'schedule:github:issue-tracking');
    assert.strictEqual(spec.profile, 'poller');
  });

  test('github.issue-tracking factory throws when issueCommentRouter missing', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.issue-tracking');
    assert.ok(factory);
    const deps = makeGitHubDeps({ issueCommentRouter: undefined });
    assert.throws(() => factory.createTaskSpec('schedule:github:issue-tracking', deps), /issueCommentRouter/);
  });

  test('github.issue-tracking factory throws when fetchIssueComments missing', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.issue-tracking');
    assert.ok(factory);
    const deps = makeGitHubDeps({ fetchIssueComments: undefined, fetchIssueState: undefined });
    assert.throws(() => factory.createTaskSpec('schedule:github:issue-tracking', deps), /fetchIssueComments/);
  });

  test('github.issue-tracking factory threads projector into spec (Cloud R5 P1)', async () => {
    // Verifies: factory passes d.projector to createIssueCommentTaskSpec so
    // awaiting_external → in_progress transitions fire on polled comments
    // without a full rebuild (per Cloud R5 P1 finding).
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.issue-tracking');
    assert.ok(factory);

    const task = {
      id: 'task-r5-projector',
      kind: 'issue_tracking',
      status: 'active',
      subjectKey: 'issue:owner/repo#99',
      threadId: 'thread-r5',
      ownerCatId: 'cat1',
      userId: 'user1',
      automationState: {},
    };
    const taskStore = {
      listByKind: async (kind) => (kind === 'issue_tracking' ? [task] : []),
      patchAutomationState: async () => {},
    };
    const events = [];
    const eventLog = {
      async append(event) {
        events.push(event);
        return { appended: true, sequence: events.length - 1 };
      },
      async read(subjectKey) {
        return events.filter((e) => e.subjectKey === subjectKey);
      },
      async listSubjects() {
        return [];
      },
    };
    const projectorApplyCalls = [];
    const projector = {
      async apply(event) {
        projectorApplyCalls.push(event);
      },
    };

    const spec = factory.createTaskSpec(
      'schedule:github:issue-tracking',
      makeGitHubDeps({
        taskStore,
        fetchIssueComments: async () => [
          { id: 10, author: 'user', body: 'help', authorAssociation: 'NONE', createdAt: '2026-01-01T00:00:00Z' },
        ],
        eventLog,
        projector,
      }),
    );

    // Gate drives the collection loop — projector.apply must be called for the collected comment.
    await spec.admission.gate();

    assert.strictEqual(
      projectorApplyCalls.length,
      1,
      'factory must thread projector into spec — apply called once per collected comment',
    );
    assert.strictEqual(projectorApplyCalls[0].payload.commentId, 10);
  });

  // --- F168 C0.3: repo-comment-poll factory ---

  test('github.repo-comment-poll factory creates TaskSpec with correct instanceId', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-comment-poll');
    assert.ok(factory);
    const spec = factory.createTaskSpec('schedule:github:repo-comment-poll', makeGitHubDeps());
    assert.strictEqual(spec.id, 'schedule:github:repo-comment-poll');
    assert.strictEqual(spec.profile, 'poller');
  });

  test('github.repo-comment-poll factory throws when repoAllowlist missing', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-comment-poll');
    assert.ok(factory);
    const deps = makeGitHubDeps({ repoAllowlist: undefined });
    assert.throws(() => factory.createTaskSpec('schedule:github:repo-comment-poll', deps), /repoAllowlist/);
  });

  test('github.repo-comment-poll factory throws when eventLog missing', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-comment-poll');
    assert.ok(factory);
    const deps = makeGitHubDeps({ eventLog: undefined });
    assert.throws(() => factory.createTaskSpec('schedule:github:repo-comment-poll', deps), /eventLog/);
  });

  test('github.repo-comment-poll factory throws when Redis cursor deps missing', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-comment-poll');
    assert.ok(factory);
    const deps = makeGitHubDeps({ readRepoCommentCursor: undefined, writeRepoCommentCursor: undefined });
    assert.throws(
      () => factory.createTaskSpec('schedule:github:repo-comment-poll', deps),
      /fetchRepoComments|RepoCommentCursor|cursor/i,
    );
  });

  test('github.repo-comment-poll factory wires collection: gate appends + projects + advances cursor (not dead code)', async () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-comment-poll');
    assert.ok(factory);

    const events = [];
    const eventLog = {
      async append(event) {
        events.push(event);
        return { appended: true, sequence: events.length - 1 };
      },
      async read(subjectKey) {
        return events.filter((e) => e.subjectKey === subjectKey);
      },
      async listSubjects() {
        return [];
      },
    };
    const projectorApplyCalls = [];
    const projector = {
      async apply(event) {
        projectorApplyCalls.push(event);
      },
    };
    const writtenCursors = [];

    const spec = factory.createTaskSpec(
      'schedule:github:repo-comment-poll',
      makeGitHubDeps({
        repoAllowlist: ['owner/repo'],
        eventLog,
        projector,
        fetchRepoComments: async () => [
          {
            issueNumber: 42,
            commentId: 7,
            author: 'bob',
            authorAssociation: 'NONE',
            body: 'still broken?',
            updatedAt: '2026-06-13T10:00:00Z',
          },
        ],
        // Non-first poll (cursor exists) so the fetch+append path runs. First-poll
        // baseline (no cursor → skip fetch) is covered in community-repo-comment-poll.test.js.
        readRepoCommentCursor: async () => '2026-06-13T00:00:00Z',
        writeRepoCommentCursor: async (_repo, cursor) => {
          writtenCursors.push(cursor);
        },
      }),
    );

    // Collection-only: gate appends + projects, always returns run:false.
    const result = await spec.admission.gate();
    assert.strictEqual(result.run, false);
    assert.strictEqual(events.length, 1, 'collected comment must be appended to the event log');
    assert.strictEqual(events[0].kind, 'issue.commented');
    assert.strictEqual(events[0].subjectKey, 'issue:owner/repo#42');
    assert.strictEqual(events[0].payload.commentId, 7);
    assert.strictEqual(projectorApplyCalls.length, 1, 'projector must apply the newly-appended comment');
    assert.deepStrictEqual(writtenCursors, ['2026-06-13T10:00:00Z'], 'cursor advances to max comment updatedAt');
  });

  test('asGitHub validates taskStore presence', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.cicd-check');
    assert.ok(factory);
    assert.throws(() => factory.createTaskSpec('schedule:github:cicd-check', { log: stubLog }), /taskStore/);
  });
});

// --- Task 4+7: Integration — enable/disable lifecycle (AC-B4) ---

describe('GitHub plugin lifecycle (AC-B4)', () => {
  // Helper: create a PluginResourceActivator with GitHub factories
  function makeTaskRunner() {
    const registered = [];
    const unregistered = [];
    const live = new Set();
    return {
      registered,
      unregistered,
      registerPostStart(task) {
        if (live.has(task.id)) throw new Error(`TaskRunnerV2: duplicate task id "${task.id}"`);
        registered.push(task);
        live.add(task.id);
      },
      unregister(taskId) {
        if (!live.has(taskId)) return false;
        live.delete(taskId);
        unregistered.push(taskId);
        return true;
      },
      register(task) {
        registered.push(task);
        live.add(task.id);
      },
    };
  }

  function createTempDir() {
    const dir = join(__dirname, `tmp-github-lifecycle-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'plugins', 'github'), { recursive: true });
    return dir;
  }

  function writeCapabilities(dir, caps) {
    const capDir = join(dir, '.cat-cafe');
    mkdirSync(capDir, { recursive: true });
    writeFileSync(join(capDir, 'capabilities.json'), JSON.stringify(caps));
  }

  function readCapabilities(dir) {
    const p = join(dir, '.cat-cafe', 'capabilities.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  }

  test('enable → 6 schedule tasks registered; disable → 6 unregistered', async () => {
    const tmpDir = createTempDir();
    try {
      // Setup
      const registry = new ScheduleFactoryRegistry();
      registerGitHubScheduleFactories(registry);
      const taskRunner = makeTaskRunner();
      writeCapabilities(tmpDir, { capabilities: [] });

      const { PluginResourceActivator } = await import('../dist/domains/plugin/PluginResourceActivator.js');
      const activator = new PluginResourceActivator({
        resolveProjectRoot: () => tmpDir,
        pluginsDir: join(tmpDir, 'plugins'),
        limbRegistry: { register: () => {}, unregister: () => {}, getNode: () => null },
        readCapabilities: async () => readCapabilities(tmpDir),
        writeCapabilities: async (cfg) => writeCapabilities(tmpDir, cfg),
        withCapabilityLock: async (fn) => fn(),
        scheduleFactoryRegistry: registry,
        taskRunner,
        scheduleFactoryDeps: makeGitHubDeps(),
      });

      const manifest = parsePluginManifest(join(__dirname, '../../../plugins/github/plugin.yaml'));
      const result = await activator.enablePlugin(manifest);

      // All 6 schedule resources should succeed
      assert.strictEqual(result.status, 'success', `enable should succeed: ${JSON.stringify(result)}`);
      assert.strictEqual(result.resources.length, 6);
      for (const r of result.resources) {
        assert.ok(r.ok, `resource ${r.name} should be ok: ${r.error}`);
      }

      // TaskRunner should have 6 registered tasks
      assert.strictEqual(taskRunner.registered.length, 6);
      const ids = taskRunner.registered.map((t) => t.id).sort();
      assert.deepStrictEqual(ids, [
        'schedule:github:cicd-check',
        'schedule:github:conflict-check',
        'schedule:github:issue-tracking',
        'schedule:github:repo-comment-poll',
        'schedule:github:repo-scan',
        'schedule:github:review-feedback',
      ]);

      // Disable → all 6 unregistered
      await activator.disablePlugin(manifest);
      assert.strictEqual(taskRunner.unregistered.length, 6);
      const unregIds = [...taskRunner.unregistered].sort();
      assert.deepStrictEqual(unregIds, ids);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('disable is persistent — migration marker prevents re-enable on restart', async () => {
    const tmpDir = createTempDir();
    try {
      const registry = new ScheduleFactoryRegistry();
      registerGitHubScheduleFactories(registry);
      const taskRunner = makeTaskRunner();
      writeCapabilities(tmpDir, { capabilities: [] });

      const { PluginResourceActivator } = await import('../dist/domains/plugin/PluginResourceActivator.js');
      const activator = new PluginResourceActivator({
        resolveProjectRoot: () => tmpDir,
        pluginsDir: join(tmpDir, 'plugins'),
        limbRegistry: { register: () => {}, unregister: () => {}, getNode: () => null },
        readCapabilities: async () => readCapabilities(tmpDir),
        writeCapabilities: async (cfg) => writeCapabilities(tmpDir, cfg),
        withCapabilityLock: async (fn) => fn(),
        scheduleFactoryRegistry: registry,
        taskRunner,
        scheduleFactoryDeps: makeGitHubDeps(),
      });

      const manifest = parsePluginManifest(join(__dirname, '../../../plugins/github/plugin.yaml'));

      // Simulate first-startup migration: write entries + marker (as index.ts does)
      const { shouldRunGitHubScheduleMigration, markGitHubScheduleMigrationDone } = await import(
        '../dist/domains/plugin/github-schedule-factories.js'
      );
      const capsBeforeEnable = readCapabilities(tmpDir);
      assert.strictEqual(
        shouldRunGitHubScheduleMigration(tmpDir, capsBeforeEnable),
        true,
        'first startup should trigger migration',
      );

      // Enable → 6 registered
      await activator.enablePlugin(manifest);
      assert.strictEqual(taskRunner.registered.length, 6);

      // Write marker (simulating what index.ts migration does after writing entries)
      markGitHubScheduleMigrationDone(tmpDir);

      // Disable → all removed from capabilities
      await activator.disablePlugin(manifest);
      const capsAfterDisable = readCapabilities(tmpDir);
      const githubEntries = capsAfterDisable.capabilities.filter(
        (c) => c.type === 'schedule' && c.pluginId === 'github',
      );
      assert.strictEqual(githubEntries.length, 0, 'disable must remove all schedule entries');

      // Simulate "restart": shouldRunGitHubScheduleMigration should return false
      // because the migration marker persists even though entries are gone
      const shouldMigrate = shouldRunGitHubScheduleMigration(tmpDir, capsAfterDisable);
      assert.strictEqual(shouldMigrate, false, 'migration must NOT re-enable after explicit disable');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('migration runs on first startup (no marker, no existing entries)', async () => {
    const tmpDir = createTempDir();
    try {
      writeCapabilities(tmpDir, { version: 1, capabilities: [] });

      const { shouldRunGitHubScheduleMigration, markGitHubScheduleMigrationDone } = await import(
        '../dist/domains/plugin/github-schedule-factories.js'
      );

      // First startup: no marker, no entries → should migrate
      const caps = readCapabilities(tmpDir);
      assert.strictEqual(shouldRunGitHubScheduleMigration(tmpDir, caps), true);

      // After migration writes marker
      markGitHubScheduleMigrationDone(tmpDir);

      // Second startup: marker exists → should NOT migrate
      assert.strictEqual(shouldRunGitHubScheduleMigration(tmpDir, caps), false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('enable with missing repo deps → 4 required succeed, 2 redis-gated optionals fail → success', async () => {
    const tmpDir = createTempDir();
    try {
      const registry = new ScheduleFactoryRegistry();
      registerGitHubScheduleFactories(registry);
      const taskRunner = makeTaskRunner();
      writeCapabilities(tmpDir, { capabilities: [] });

      const { PluginResourceActivator } = await import('../dist/domains/plugin/PluginResourceActivator.js');
      // Remove repo deps to simulate no redis — both repo-scan AND repo-comment-poll
      // are redis-gated optionals that require repoAllowlist.
      const deps = makeGitHubDeps({ repoAllowlist: undefined, reconciliationDedup: undefined });
      const activator = new PluginResourceActivator({
        resolveProjectRoot: () => tmpDir,
        pluginsDir: join(tmpDir, 'plugins'),
        limbRegistry: { register: () => {}, unregister: () => {}, getNode: () => null },
        readCapabilities: async () => readCapabilities(tmpDir),
        writeCapabilities: async (cfg) => writeCapabilities(tmpDir, cfg),
        withCapabilityLock: async (fn) => fn(),
        scheduleFactoryRegistry: registry,
        taskRunner,
        scheduleFactoryDeps: deps,
      });

      const manifest = parsePluginManifest(join(__dirname, '../../../plugins/github/plugin.yaml'));
      const result = await activator.enablePlugin(manifest);

      // 4 succeed, 2 fail (repo-scan + repo-comment-poll — both optional), overall status = success
      assert.strictEqual(result.status, 'success');
      const succeeded = result.resources.filter((r) => r.ok);
      const failed = result.resources.filter((r) => !r.ok);
      assert.strictEqual(succeeded.length, 4);
      assert.strictEqual(failed.length, 2);
      const failedNames = failed.map((r) => r.name).sort();
      assert.deepStrictEqual(failedNames, ['repo-comment-poll', 'repo-scan']);
      for (const r of failed) {
        assert.ok(r.error?.includes('repoAllowlist'), `${r.name} should fail on repoAllowlist: ${r.error}`);
      }

      // Only 4 tasks registered (all except the 2 redis-gated optionals)
      assert.strictEqual(taskRunner.registered.length, 4);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --- Plugin config env resolution ---

test('resolvePluginEnv reads plugin config store without mutating process.env', async () => {
  const tmpDir = join(tmpdir(), `f202-phase2-env-resolve-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const testEnvKey = `F202_PHASE2_TEST_RESOLVE_${Date.now()}`;
  const previous = process.env[testEnvKey];
  try {
    const { writePluginConfig, loadAllPluginConfigs, resolvePluginEnv } = await import(
      '../dist/domains/plugin/plugin-config-store.js'
    );

    const testManifest = {
      id: 'test-resolve',
      name: 'Test Resolve',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: testEnvKey, label: 'Test', sensitive: false, required: false }],
      resources: [],
    };

    process.env[testEnvKey] = 'ambient-shell-value';
    writePluginConfig(tmpDir, 'test-resolve', [{ name: testEnvKey, value: 'plugin-store-value' }]);
    loadAllPluginConfigs(tmpDir, [testManifest]);

    const resolved = resolvePluginEnv([testManifest]);

    assert.strictEqual(resolved[testEnvKey], 'plugin-store-value');
    assert.strictEqual(process.env[testEnvKey], 'ambient-shell-value');
  } finally {
    if (previous === undefined) delete process.env[testEnvKey];
    else process.env[testEnvKey] = previous;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolvePluginEnv falls back to process.env when plugin config is absent', async () => {
  const tmpDir = join(tmpdir(), `f202-phase2-env-fallback-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const testEnvKey = `F202_PHASE2_TEST_FALLBACK_${Date.now()}`;
  const previous = process.env[testEnvKey];
  try {
    const { loadAllPluginConfigs, resolvePluginEnv } = await import('../dist/domains/plugin/plugin-config-store.js');

    const testManifest = {
      id: 'test-fallback',
      name: 'Test Fallback',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: testEnvKey, label: 'Test', sensitive: false, required: false }],
      resources: [],
    };

    process.env[testEnvKey] = 'ambient-shell-value';
    loadAllPluginConfigs(tmpDir, [testManifest]);

    const resolved = resolvePluginEnv([testManifest]);

    assert.strictEqual(resolved[testEnvKey], 'ambient-shell-value');
    assert.strictEqual(process.env[testEnvKey], 'ambient-shell-value');
  } finally {
    if (previous === undefined) delete process.env[testEnvKey];
    else process.env[testEnvKey] = previous;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolvePluginEnv treats an explicitly cleared plugin config value as absent without mutating process.env', async () => {
  const tmpDir = join(tmpdir(), `f202-phase2-env-clear-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const testEnvKey = `F202_PHASE2_TEST_CLEAR_${Date.now()}`;
  const previous = process.env[testEnvKey];
  try {
    const { writePluginConfig, loadAllPluginConfigs, resolvePluginEnv } = await import(
      '../dist/domains/plugin/plugin-config-store.js'
    );

    const testManifest = {
      id: 'test-clear',
      name: 'Test Clear',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: testEnvKey, label: 'Test', sensitive: false, required: false }],
      resources: [],
    };

    process.env[testEnvKey] = 'ambient-shell-value';
    writePluginConfig(tmpDir, 'test-clear', [{ name: testEnvKey, value: null }]);
    loadAllPluginConfigs(tmpDir, [testManifest]);

    const resolved = resolvePluginEnv([testManifest]);

    assert.ok(Object.hasOwn(resolved, testEnvKey));
    assert.strictEqual(resolved[testEnvKey], undefined);
    assert.strictEqual(process.env[testEnvKey], 'ambient-shell-value');
  } finally {
    if (previous === undefined) delete process.env[testEnvKey];
    else process.env[testEnvKey] = previous;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('buildGitHubMigrationEntries (P2-B)', () => {
  test('persists repo-scan pending when env deps are missing at first migration', async () => {
    const { buildGitHubMigrationEntries } = await import('../dist/domains/plugin/github-schedule-factories.js');

    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'conflict-check' },
        { type: 'schedule', name: 'review-feedback' },
        { type: 'schedule', name: 'repo-scan' },
      ],
    };

    // No repo-scan env vars at upgrade time: keep a disabled/pending row so
    // adding env later + restart can promote it after the one-time marker exists.
    const entries = buildGitHubMigrationEntries(manifest, {});
    assert.strictEqual(entries.length, 4, 'should keep repo-scan pending when deps are missing');
    const repoScan = entries.find((e) => e.id === 'plugin:github:repo-scan');
    assert.ok(repoScan, 'repo-scan pending entry should be present');
    assert.strictEqual(repoScan.enabled, false, 'pending repo-scan must not be reported enabled');
    assert.strictEqual(repoScan.migrationPendingReason, 'deps-unavailable');
    assert.ok(entries.some((e) => e.id.includes('cicd-check')));
    assert.ok(entries.some((e) => e.id.includes('conflict-check')));
    assert.ok(entries.some((e) => e.id.includes('review-feedback')));
  });

  test('includes repo-scan when env deps are present', async () => {
    const { buildGitHubMigrationEntries } = await import('../dist/domains/plugin/github-schedule-factories.js');

    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-scan' },
      ],
    };

    const entries = buildGitHubMigrationEntries(manifest, {
      GITHUB_REPO_ALLOWLIST: 'my-org/my-repo',
      GITHUB_REPO_INBOX_CAT_ID: 'cat-123',
    });
    assert.strictEqual(entries.length, 2, 'should include repo-scan when deps present');
    assert.ok(entries.some((e) => e.id.includes('repo-scan')));
  });

  test('merges process repo-scan deps into plugin migration env', async () => {
    const { buildGitHubMigrationEntries, buildGitHubMigrationEnv } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );

    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-scan' },
      ],
    };

    const migrationEnv = buildGitHubMigrationEnv(
      { GITHUB_TOKEN: 'plugin-token' },
      {
        GITHUB_REPO_ALLOWLIST: 'org/repo',
        GITHUB_REPO_INBOX_CAT_ID: 'cat-1',
      },
    );
    const entries = buildGitHubMigrationEntries(manifest, migrationEnv);

    assert.strictEqual(entries.length, 2, 'should include repo-scan when only process env has repo-scan deps');
    assert.ok(entries.some((e) => e.id.includes('repo-scan')));
    assert.equal(migrationEnv.GITHUB_TOKEN, 'plugin-token');
  });

  test('each entry has correct shape', async () => {
    const { buildGitHubMigrationEntries } = await import('../dist/domains/plugin/github-schedule-factories.js');

    const entries = buildGitHubMigrationEntries({ resources: [{ type: 'schedule', name: 'cicd-check' }] }, {});
    assert.strictEqual(entries.length, 1);
    const e = entries[0];
    assert.strictEqual(e.id, 'plugin:github:cicd-check');
    assert.strictEqual(e.type, 'schedule');
    assert.strictEqual(e.enabled, true);
    assert.strictEqual(e.source, 'cat-cafe');
    assert.strictEqual(e.pluginId, 'github');
    assert.strictEqual(e.scheduleTaskId, 'schedule:github:cicd-check');
  });

  test('persists repo-scan pending when env deps exist but Redis deps are unavailable', async () => {
    const { buildGitHubMigrationEntries } = await import('../dist/domains/plugin/github-schedule-factories.js');
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-scan' },
      ],
    };
    // Env deps present BUT Redis deps unavailable
    const entries = buildGitHubMigrationEntries(
      manifest,
      { GITHUB_REPO_ALLOWLIST: 'org/repo', GITHUB_REPO_INBOX_CAT_ID: 'cat-1' },
      { repoScanDepsAvailable: false },
    );
    assert.strictEqual(entries.length, 2, 'should preserve repo-scan as pending for later completion');
    const repoScan = entries.find((e) => e.id.includes('repo-scan'));
    assert.ok(repoScan, 'repo-scan entry should be present');
    assert.strictEqual(repoScan.enabled, false, 'pending repo-scan must not be reported enabled');
    assert.strictEqual(repoScan.migrationPendingReason, 'deps-unavailable');
    assert.ok(entries.some((e) => e.id.includes('cicd-check')));
  });

  test('promotes pending repo-scan migration entry once Redis deps become available', async () => {
    const { buildGitHubMigrationEntries, promotePendingGitHubMigrationEntries } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-scan' },
      ],
    };
    const env = { GITHUB_REPO_ALLOWLIST: 'org/repo', GITHUB_REPO_INBOX_CAT_ID: 'cat-1' };
    const pendingCaps = {
      version: 1,
      capabilities: buildGitHubMigrationEntries(manifest, env, { repoScanDepsAvailable: false }),
    };

    const result = promotePendingGitHubMigrationEntries(pendingCaps, manifest, env, { repoScanDepsAvailable: true });

    assert.strictEqual(result.changed, true);
    const repoScan = result.config.capabilities.find((e) => e.id === 'plugin:github:repo-scan');
    assert.ok(repoScan, 'repo-scan entry should still exist');
    assert.strictEqual(repoScan.enabled, true);
    assert.strictEqual(repoScan.migrationPendingReason, undefined);
  });

  test('promotes repo-scan that was pending because env deps were absent at first migration', async () => {
    const { buildGitHubMigrationEntries, promotePendingGitHubMigrationEntries } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-scan' },
      ],
    };
    const pendingCaps = {
      version: 1,
      capabilities: buildGitHubMigrationEntries(manifest, {}),
    };

    const result = promotePendingGitHubMigrationEntries(
      pendingCaps,
      manifest,
      { GITHUB_REPO_ALLOWLIST: 'org/repo', GITHUB_REPO_INBOX_CAT_ID: 'cat-1' },
      { repoScanDepsAvailable: true },
    );

    assert.strictEqual(result.changed, true);
    const repoScan = result.config.capabilities.find((e) => e.id === 'plugin:github:repo-scan');
    assert.ok(repoScan, 'repo-scan entry should still exist');
    assert.strictEqual(repoScan.enabled, true);
    assert.strictEqual(repoScan.migrationPendingReason, undefined);
  });

  test('keeps pending repo-scan disabled until Redis deps are available', async () => {
    const { buildGitHubMigrationEntries, promotePendingGitHubMigrationEntries } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-scan' },
      ],
    };
    const env = { GITHUB_REPO_ALLOWLIST: 'org/repo', GITHUB_REPO_INBOX_CAT_ID: 'cat-1' };
    const pendingCaps = {
      version: 1,
      capabilities: buildGitHubMigrationEntries(manifest, env, { repoScanDepsAvailable: false }),
    };

    const result = promotePendingGitHubMigrationEntries(pendingCaps, manifest, env, { repoScanDepsAvailable: false });

    assert.strictEqual(result.changed, false);
    const repoScan = result.config.capabilities.find((e) => e.id === 'plugin:github:repo-scan');
    assert.strictEqual(repoScan.enabled, false);
    assert.strictEqual(repoScan.migrationPendingReason, 'deps-unavailable');
  });

  test('builds scheduler override migrations for legacy GitHub poller IDs', async () => {
    const { buildGitHubMigrationEntries, buildGitHubScheduleOverrideMigrations } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'conflict-check' },
        { type: 'schedule', name: 'issue-tracking' },
        { type: 'schedule', name: 'review-feedback' },
      ],
    };

    const entries = buildGitHubMigrationEntries(manifest, {});
    const migrations = buildGitHubScheduleOverrideMigrations(entries, [
      { taskId: 'cicd-check', enabled: false, updatedBy: 'opus', updatedAt: '2026-02-19T08:00:00.000Z' },
      { taskId: 'review-feedback', enabled: false, updatedBy: 'lang', updatedAt: '2026-02-19T08:00:00.000Z' },
      { taskId: 'conflict-check', enabled: false, updatedBy: 'old', updatedAt: '2026-02-19T08:00:00.000Z' },
      {
        taskId: 'schedule:github:conflict-check',
        enabled: true,
        updatedBy: 'new',
        updatedAt: '2026-02-19T08:00:00.000Z',
      },
      { taskId: 'issue-tracking', enabled: false, updatedBy: 'stray', updatedAt: '2026-02-19T08:00:00.000Z' },
    ]);

    assert.deepStrictEqual(migrations, [
      {
        legacyTaskId: 'cicd-check',
        taskId: 'schedule:github:cicd-check',
        enabled: false,
        updatedBy: 'opus',
      },
      {
        legacyTaskId: 'review-feedback',
        taskId: 'schedule:github:review-feedback',
        enabled: false,
        updatedBy: 'lang',
      },
    ]);
  });

  // --- F168 C0.3: repo-comment-poll redis-gated pending (twin of repo-scan) ---

  test('repo-comment-poll is redis-gated pending like repo-scan when deps missing', async () => {
    const { buildGitHubMigrationEntries } = await import('../dist/domains/plugin/github-schedule-factories.js');
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-scan' },
        { type: 'schedule', name: 'repo-comment-poll' },
      ],
    };
    // No repo env → BOTH redis-gated resources kept pending (avoids ghost-enabled P2-1).
    const entries = buildGitHubMigrationEntries(manifest, {});
    assert.strictEqual(entries.length, 3);
    const rcp = entries.find((e) => e.id === 'plugin:github:repo-comment-poll');
    assert.ok(rcp, 'repo-comment-poll entry should be present');
    assert.strictEqual(rcp.enabled, false, 'pending repo-comment-poll must not be reported enabled');
    assert.strictEqual(rcp.migrationPendingReason, 'deps-unavailable');
    // cicd-check (not redis-gated) stays enabled
    const cicd = entries.find((e) => e.id === 'plugin:github:cicd-check');
    assert.strictEqual(cicd.enabled, true);
  });

  test('repo-comment-poll promotes (with repo-scan) once redis deps become available', async () => {
    const { buildGitHubMigrationEntries, promotePendingGitHubMigrationEntries } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );
    const manifest = {
      resources: [
        { type: 'schedule', name: 'repo-scan' },
        { type: 'schedule', name: 'repo-comment-poll' },
      ],
    };
    const env = { GITHUB_REPO_ALLOWLIST: 'org/repo', GITHUB_REPO_INBOX_CAT_ID: 'cat-1' };
    const pendingCaps = {
      version: 1,
      capabilities: buildGitHubMigrationEntries(manifest, env, { repoScanDepsAvailable: false }),
    };

    const result = promotePendingGitHubMigrationEntries(pendingCaps, manifest, env, { repoScanDepsAvailable: true });
    assert.strictEqual(result.changed, true);
    const rcp = result.config.capabilities.find((e) => e.id === 'plugin:github:repo-comment-poll');
    assert.ok(rcp, 'repo-comment-poll entry should still exist');
    assert.strictEqual(rcp.enabled, true);
    assert.strictEqual(rcp.migrationPendingReason, undefined);
    // repo-scan also promoted (both redis-gated)
    const rs = result.config.capabilities.find((e) => e.id === 'plugin:github:repo-scan');
    assert.strictEqual(rs.enabled, true);
  });

  // --- F168 C0.3 (cloud review P1-1): backfill new manifest resource to existing installs ---

  test('backfill adds a new manifest schedule resource missing from an existing install', async () => {
    const { backfillMissingGitHubScheduleEntries } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );
    // Existing install: one-time migration already ran (has cicd-check), but NO repo-comment-poll.
    const config = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:github:cicd-check',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'github',
          scheduleTaskId: 'schedule:github:cicd-check',
        },
      ],
    };
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-comment-poll' }, // new resource, absent from caps
      ],
    };
    const result = backfillMissingGitHubScheduleEntries(
      config,
      manifest,
      { GITHUB_REPO_ALLOWLIST: 'org/repo', GITHUB_REPO_INBOX_CAT_ID: 'cat-1' },
      { repoScanDepsAvailable: true },
    );
    assert.strictEqual(result.changed, true);
    const rcp = result.config.capabilities.find((e) => e.id === 'plugin:github:repo-comment-poll');
    assert.ok(rcp, 'repo-comment-poll backfilled into existing install');
    assert.strictEqual(rcp.enabled, true); // redis deps available → enabled
    assert.ok(
      result.config.capabilities.find((e) => e.id === 'plugin:github:cicd-check'),
      'existing entry untouched',
    );
  });

  test('backfill is one-time — alreadyBackfilled does NOT resurrect a disabled TARGET (cloud R2 P1)', async () => {
    const { backfillMissingGitHubScheduleEntries } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );
    // Operator disabled repo-comment-poll → removeCapabilityEntry PHYSICALLY removed the row,
    // so capabilities has NO repo-comment-poll. With the one-time marker already set, backfill
    // must NOT recreate it (the bug cloud R2 P1 flagged).
    const config = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:github:cicd-check',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'github',
          scheduleTaskId: 'schedule:github:cicd-check',
        },
      ],
    };
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-comment-poll' },
      ],
    };
    const result = backfillMissingGitHubScheduleEntries(
      config,
      manifest,
      { GITHUB_REPO_ALLOWLIST: 'org/repo', GITHUB_REPO_INBOX_CAT_ID: 'cat-1' },
      { repoScanDepsAvailable: true, alreadyBackfilled: true },
    );
    assert.strictEqual(result.changed, false, 'one-time guard: must not resurrect disabled repo-comment-poll');
  });

  test('backfill only touches TARGET — does NOT resurrect a disabled legacy resource (cloud R2 P1)', async () => {
    const { backfillMissingGitHubScheduleEntries } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );
    // Operator disabled repo-scan (legacy) before upgrade → physically removed. backfill must
    // NOT resurrect it (not a TARGET resource), but still backfills the new repo-comment-poll.
    const config = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:github:cicd-check',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'github',
          scheduleTaskId: 'schedule:github:cicd-check',
        },
      ],
    };
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-scan' }, // legacy, disabled (physically removed)
        { type: 'schedule', name: 'repo-comment-poll' }, // new TARGET
      ],
    };
    const result = backfillMissingGitHubScheduleEntries(
      config,
      manifest,
      { GITHUB_REPO_ALLOWLIST: 'org/repo', GITHUB_REPO_INBOX_CAT_ID: 'cat-1' },
      { repoScanDepsAvailable: true },
    );
    assert.ok(
      result.config.capabilities.find((e) => e.id === 'plugin:github:repo-comment-poll'),
      'TARGET repo-comment-poll is backfilled',
    );
    assert.ok(
      !result.config.capabilities.find((e) => e.id === 'plugin:github:repo-scan'),
      'legacy disabled repo-scan must NOT be resurrected (not a TARGET)',
    );
  });

  test('backfill keeps redis-gated resource pending when deps unavailable', async () => {
    const { backfillMissingGitHubScheduleEntries } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );
    const config = {
      version: 1,
      capabilities: [
        {
          id: 'plugin:github:cicd-check',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'github',
          scheduleTaskId: 'schedule:github:cicd-check',
        },
      ],
    };
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-comment-poll' },
      ],
    };
    // No repo env → redis-gated repo-comment-poll backfilled as pending (avoids ghost-enabled).
    const result = backfillMissingGitHubScheduleEntries(config, manifest, {}, { repoScanDepsAvailable: false });
    assert.strictEqual(result.changed, true);
    const rcp = result.config.capabilities.find((e) => e.id === 'plugin:github:repo-comment-poll');
    assert.ok(rcp);
    assert.strictEqual(rcp.enabled, false);
    assert.strictEqual(rcp.migrationPendingReason, 'deps-unavailable');
  });

  test('backfill gated on plugin-active — does NOT resurrect when GitHub plugin was disabled (cloud R3 P1)', async () => {
    const { backfillMissingGitHubScheduleEntries } = await import(
      '../dist/domains/plugin/github-schedule-factories.js'
    );
    // Operator disabled the whole GitHub plugin before upgrade → deactivateSchedule physically
    // removed ALL github schedule rows. capabilities has no github rows; the f202 marker still
    // suppresses migration. backfill must NOT resurrect repo-comment-poll.
    const config = {
      version: 1,
      capabilities: [
        // a non-github schedule remains; NO github schedule rows (github plugin disabled)
        {
          id: 'plugin:other:something',
          type: 'schedule',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'other',
          scheduleTaskId: 'schedule:other:something',
        },
      ],
    };
    const manifest = {
      resources: [
        { type: 'schedule', name: 'cicd-check' },
        { type: 'schedule', name: 'repo-comment-poll' },
      ],
    };
    const result = backfillMissingGitHubScheduleEntries(
      config,
      manifest,
      { GITHUB_REPO_ALLOWLIST: 'org/repo', GITHUB_REPO_INBOX_CAT_ID: 'cat-1' },
      { repoScanDepsAvailable: true },
    );
    assert.strictEqual(
      result.changed,
      false,
      'plugin-active gate: no github schedule rows (plugin disabled) → must not backfill/resurrect',
    );
  });
});

// --- #949 Wiring regression: threadStore must reach ReviewFeedbackTaskSpec ---

describe('#949 wiring regression: threadStore reaches review-feedback factory', () => {
  test('reviewFeedbackFactory passes threadStore to createReviewFeedbackTaskSpec', async () => {
    const { githubScheduleFactories } = await import('../dist/domains/plugin/github-schedule-factories.js');
    const reviewFeedbackFactory = githubScheduleFactories.find((f) => f.factoryId === 'github.review-feedback');
    assert.ok(reviewFeedbackFactory, 'review-feedback factory must exist in exported array');
    const threadCreateCalls = [];
    const mockThreadStore = {
      create: (userId, title, projectPath) => {
        threadCreateCalls.push({ userId, title, projectPath });
        return {
          id: 'thread_rotated_1',
          title,
          createdBy: userId,
          createdAt: Date.now(),
          participants: [],
          projectPath: projectPath ?? 'default',
          lastActiveAt: Date.now(),
        };
      },
      get: (threadId) => {
        if (threadId === 'th-old') {
          return { id: 'th-old', projectPath: '/projects/cat-cafe', title: 'Original' };
        }
        return null;
      },
    };
    const deps = makeGitHubDeps({ threadStore: mockThreadStore });
    const spec = reviewFeedbackFactory.createTaskSpec('schedule:github:review-feedback', deps);

    // The spec should be created with threadStore wired in.
    // Verify by creating a task at the rotation threshold and checking rotation fires.
    const task = {
      id: 'task-1',
      kind: 'pr_tracking',
      threadId: 'th-old',
      subjectKey: 'pr:owner/repo#42',
      title: 'PR owner/repo#42',
      ownerCatId: 'opus',
      status: 'todo',
      why: '',
      createdBy: 'opus',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      userId: 'u-1',
      automationState: {
        review: { lastCommentCursor: 0, lastDecisionCursor: 0, completedReviewCount: 3 },
      },
    };

    // Replace taskStore in deps to serve our test task
    const patchCalls = [];
    const updateCalls = [];
    deps.taskStore = {
      listByKind: async () => [task],
      update: async (taskId, input) => {
        updateCalls.push({ taskId, input });
        return { ...task, ...input };
      },
      patchAutomationState: async (taskId, patch) => {
        patchCalls.push({ taskId, patch });
        return task;
      },
    };
    deps.fetchComments = async () => [
      { id: 99, author: 'alice', body: 'fix it', createdAt: '2026-01-01', commentType: 'conversation' },
    ];
    deps.reviewFeedbackRouter = {
      route: async (_signal, tracking) => ({
        kind: 'notified',
        threadId: tracking.threadId,
        catId: tracking.catId,
        messageId: 'msg-1',
        content: 'feedback',
      }),
    };

    // Re-create spec with updated deps
    const spec2 = reviewFeedbackFactory.createTaskSpec('schedule:github:review-feedback', deps);
    const gateResult = await spec2.admission.gate({ taskId: spec2.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true, 'gate should fire');
    await spec2.run.execute(gateResult.workItems[0].signal, 'pr:owner/repo#42', {});

    // KEY ASSERTION: threadStore.create should have been called (rotation happened)
    assert.equal(threadCreateCalls.length, 1, 'threadStore.create must be called — wiring is live');
    // Task should be updated with new threadId
    assert.ok(
      updateCalls.some((c) => c.input.threadId === 'thread_rotated_1'),
      'task threadId should be updated',
    );
    // completedReviewCount should reset to 1
    assert.ok(
      patchCalls.some((c) => c.patch.review?.completedReviewCount === 1),
      'completedReviewCount should reset to 1 after rotation',
    );
  });

  test('makeGitHubDeps without threadStore still creates spec (graceful degradation)', async () => {
    const { githubScheduleFactories } = await import('../dist/domains/plugin/github-schedule-factories.js');
    const reviewFeedbackFactory = githubScheduleFactories.find((f) => f.factoryId === 'github.review-feedback');
    const deps = makeGitHubDeps(); // no threadStore
    const spec = reviewFeedbackFactory.createTaskSpec('schedule:github:review-feedback', deps);
    assert.ok(spec, 'spec should be created even without threadStore');
    assert.strictEqual(spec.id, 'schedule:github:review-feedback');
  });
});
