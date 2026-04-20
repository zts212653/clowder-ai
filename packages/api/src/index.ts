/**
 * Cat Cafe API Server
 * 后端 API 入口
 */

import { join } from 'node:path';
import { type CatConfig, type CatId, CORE_COMMANDS, catRegistry } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createRedisClient, SessionStore } from '@cat-cafe/shared/utils';
import fastifyCookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { resolveAnthropicRuntimeProfile, resolveForClient } from './config/account-resolver.js';
import { generateCliConfigs, readCapabilitiesConfig } from './config/capabilities/capability-orchestrator.js';
import { resolveBoundAccountRefForCat } from './config/cat-account-binding.js';
import { getCatContextBudget } from './config/cat-budgets.js';
import {
  bootstrapDefaultCatCatalog,
  getAcpConfig,
  getAllCatIdsFromConfig,
  getConfigSessionStrategy,
  isCatAvailable,
  toAllCatConfigs,
} from './config/cat-config-loader.js';
import { resolveFrontendBaseUrl, resolveFrontendCorsOrigins } from './config/frontend-origin.js';
import { initRuntimeOverrides } from './config/session-strategy-overrides.js';
import { assertStorageReady } from './config/storage-guard.js';
import { createTaskProgressStore } from './domains/cats/services/agents/invocation/createTaskProgressStore.js';
import { InvocationQueue } from './domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from './domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from './domains/cats/services/agents/invocation/InvocationTracker.js';
import type {
  InvocationRecordStoreLike,
  RouterLike,
} from './domains/cats/services/agents/invocation/QueueProcessor.js';
import { QueueProcessor } from './domains/cats/services/agents/invocation/QueueProcessor.js';
import { AntigravityAgentService } from './domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import { AgentRegistry } from './domains/cats/services/agents/registry/AgentRegistry.js';
import { AuthorizationManager } from './domains/cats/services/auth/AuthorizationManager.js';
import {
  AgentRouter,
  AuditEventTypes,
  ClaudeAgentService,
  CodexAgentService,
  createDraftStore,
  createInvocationRecordStore,
  createSessionChainStore,
  DareAgentService,
  DeliveryCursorStore,
  GeminiAgentService,
  getEventAuditLog,
  KimiAgentService,
  MemoryGovernanceStore,
  OpenCodeAgentService,
} from './domains/cats/services/index.js';
import { initPushNotificationService } from './domains/cats/services/push/PushNotificationService.js';
import type { HandoffConfig } from './domains/cats/services/session/SessionSealer.js';
import { SessionSealer } from './domains/cats/services/session/SessionSealer.js';
import { TranscriptReader } from './domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from './domains/cats/services/session/TranscriptWriter.js';
import { createAuthorizationAuditStore } from './domains/cats/services/stores/factories/AuthorizationAuditStoreFactory.js';
import { createAuthorizationRuleStore } from './domains/cats/services/stores/factories/AuthorizationRuleStoreFactory.js';
import { createBacklogStore } from './domains/cats/services/stores/factories/BacklogStoreFactory.js';
import { createCommunityIssueStore } from './domains/cats/services/stores/factories/CommunityIssueStoreFactory.js';
import { createMemoryStore } from './domains/cats/services/stores/factories/MemoryStoreFactory.js';
import { createMessageStore } from './domains/cats/services/stores/factories/MessageStoreFactory.js';
import { createPendingRequestStore } from './domains/cats/services/stores/factories/PendingRequestStoreFactory.js';
import { createPushSubscriptionStore } from './domains/cats/services/stores/factories/PushSubscriptionStoreFactory.js';
import { createReadStateStore } from './domains/cats/services/stores/factories/ReadStateStoreFactory.js';
import { createSummaryStore } from './domains/cats/services/stores/factories/SummaryStoreFactory.js';
import { createTaskStore } from './domains/cats/services/stores/factories/TaskStoreFactory.js';
import { createThreadStore } from './domains/cats/services/stores/factories/ThreadStoreFactory.js';
import { createWorkflowSopStore } from './domains/cats/services/stores/factories/WorkflowSopStoreFactory.js';
import { RedisInvocationRecordStore } from './domains/cats/services/stores/redis/RedisInvocationRecordStore.js';
import { RedisMessageStore } from './domains/cats/services/stores/redis/RedisMessageStore.js';
import { MlxAudioTtsProvider } from './domains/cats/services/tts/MlxAudioTtsProvider.js';
import { initStreamingTtsRegistry } from './domains/cats/services/tts/StreamingTtsChunker.js';
import { TtsRegistry } from './domains/cats/services/tts/TtsRegistry.js';
import { startTtsCacheCleaner } from './domains/cats/services/tts/tts-cache-cleaner.js';
import { initVoiceBlockSynthesizer } from './domains/cats/services/tts/VoiceBlockSynthesizer.js';
import type { AgentService } from './domains/cats/services/types.js';
import { ActivityTracker } from './domains/health/ActivityTracker.js';
import { PortDiscoveryService } from './domains/preview/port-discovery.js';
import { collectRuntimePorts } from './domains/preview/port-validator.js';
import { PreviewGateway } from './domains/preview/preview-gateway.js';
import { createSignalArticleLookup } from './domains/signals/services/signal-thread-lookup.js';
import { AgentPaneRegistry } from './domains/terminal/agent-pane-registry.js';
import { TmuxGateway } from './domains/terminal/tmux-gateway.js';
import { CommandRegistry } from './infrastructure/commands/CommandRegistry.js';
import { parseManifestSlashCommands } from './infrastructure/commands/manifest-commands.js';
import {
  loadConnectorGatewayConfig,
  startConnectorGateway,
} from './infrastructure/connectors/connector-gateway-bootstrap.js';
import { restartConnectorGateway } from './infrastructure/connectors/connector-gateway-lifecycle.js';
import { createConnectorReloadSubscriber } from './infrastructure/connectors/connector-reload-subscriber.js';
import {
  CiCdRouter,
  ConflictRouter,
  ConnectorInvokeTrigger,
  GhCliReviewContentFetcher,
  MemoryProcessedEmailStore,
  ReviewFeedbackRouter,
  ReviewRouter,
  startGithubReviewWatcher,
  stopGithubReviewWatcher,
} from './infrastructure/email/index.js';
import { runSchedulerReplyUserIdBackfill } from './infrastructure/scheduler/scheduler-reply-userid-backfill.js';
import { securityHeadersPlugin } from './infrastructure/security-headers.js';
import { sessionAuthPlugin, sessionRoute } from './infrastructure/session-auth.js';
import { SocketManager } from './infrastructure/websocket/index.js';
import { configSecretsRoutes } from './routes/config-secrets.js';
import { connectorWebhookRoutes } from './routes/connector-webhooks.js';
import { gameRoutes } from './routes/games.js';
import {
  accountsRoutes,
  auditRoutes,
  authorizationRoutes,
  backlogRoutes,
  bootcampRoutes,
  brakeRoutes,
  callbackAuthRoutes,
  callbacksRoutes,
  capabilitiesRoutes,
  catsRoutes,
  claudeRescueRoutes,
  commandsRoutes,
  communityIssueRoutes,
  configRoutes,
  connectorHubRoutes,
  connectorMediaRoutes,
  distillationRoutes,
  evidenceRoutes,
  executionDigestRoutes,
  exportRoutes,
  externalProjectRoutes,
  featureDocDetailRoutes,
  governanceStatusRoute,
  guideActionRoutes,
  intentCardRoutes,
  invocationsRoutes,
  leaderboardEventsRoutes,
  leaderboardRoutes,
  memoryPublishRoutes,
  memoryRoutes,
  messageActionsRoutes,
  messagesRoutes,
  mkdirRoute,
  packsRoutes,
  projectSetupRoute,
  projectsBootstrapRoutes,
  projectsRoutes,
  pushRoutes,
  queueRoutes,
  quotaRoutes,
  reflectRoutes,
  refluxRoutes,
  registerCallbackDocsRoutes,
  resolutionRoutes,
  sessionChainRoutes,
  sessionHooksRoutes,
  sessionStrategyConfigRoutes,
  sessionTranscriptRoutes,
  signalCollectionRoutes,
  signalPodcastRoutes,
  signalStudyRoutes,
  signalsRoutes,
  skillsRoutes,
  sliceRoutes,
  summariesRoutes,
  tasksRoutes,
  threadBranchRoutes,
  threadCatsRoutes,
  threadsRoutes,
  toolUsageRoutes,
  ttsRoutes,
  uploadsRoutes,
  usageRoutes,
  workflowSopRoutes,
  workspaceEditRoutes,
  workspaceGitRoutes,
  workspaceRoutes,
} from './routes/index.js';
import { knowledgeFeedRoutes } from './routes/knowledge-feed.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { previewRoutes } from './routes/preview.js';
import { terminalRoutes } from './routes/terminal.js';
import { threadExportRoutes } from './routes/thread-export.js';
import { ApiInstanceLease, type ApiInstanceLeaseInvalidation } from './services/ApiInstanceLease.js';
import { findMonorepoRoot } from './utils/monorepo-root.js';
import { resolveUserId } from './utils/request-identity.js';

const PORT = parseInt(process.env.API_SERVER_PORT ?? '3004', 10);
const HOST = process.env.API_SERVER_HOST ?? '127.0.0.1';

let socketManager: SocketManager | null = null;
let redisClient: RedisClient | null = null;

/**
 * Get the SocketManager instance
 * @throws Error if SocketManager is not initialized
 */
export function getSocketManager(): SocketManager {
  if (!socketManager) {
    throw new Error('SocketManager not initialized');
  }
  return socketManager;
}

const PROCESS_START_AT = Date.now();

async function main(): Promise<void> {
  const { logger: customLogger, isDebugMode, LOG_DIR_PATH } = await import('./infrastructure/logger.js');

  // F152: Initialize OpenTelemetry SDK (must be early, before routes)
  const { initTelemetry } = await import('./infrastructure/telemetry/init.js');
  const shutdownTelemetry = initTelemetry();

  const app = Fastify({ logger: customLogger as unknown as import('fastify').FastifyBaseLogger });

  if (isDebugMode) {
    app.log.info({ logDir: LOG_DIR_PATH }, '[api] Debug mode enabled (--debug flag)');
  }

  // CORS for frontend
  await app.register(cors, {
    origin: resolveFrontendCorsOrigins(process.env, app.log),
    credentials: true,
  });

  // F156 D-2: Anti-clickjacking headers (X-Frame-Options + CSP frame-ancestors)
  await app.register(securityHeadersPlugin);

  // F156 D-1: Cookie parsing + session-based identity (replaces userId self-reporting)
  await app.register(fastifyCookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute);

  // WebSocket support (F089 terminal)
  await app.register(fastifyWebsocket);

  // Prevent Fastify from intercepting Socket.IO paths — Socket.IO handles
  // them via its own http server listeners (both polling and WebSocket).
  // Without this, @fastify/websocket causes Fastify to send 404 for
  // /socket.io/ upgrade requests, killing WebSocket transport entirely.
  app.addHook('onRequest', (_request, reply, done) => {
    if (_request.url.startsWith('/socket.io/')) {
      reply.hijack();
    }
    done();
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  // F152: Readiness check — verifies dependencies are reachable.
  // evidenceStoreRef is set after memoryServices init; handler runs at request time.
  let evidenceStoreRef: { health(): Promise<boolean> } | null = null;
  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; ms: number; error?: string }> = {};
    // Redis probe
    if (redisClient) {
      const t0 = Date.now();
      try {
        await redisClient.ping();
        checks.redis = { ok: true, ms: Date.now() - t0 };
      } catch (err) {
        checks.redis = { ok: false, ms: Date.now() - t0, error: String(err) };
      }
    } else {
      checks.redis = { ok: true, ms: 0 }; // memory mode, always ready
    }
    // SQLite probe
    if (evidenceStoreRef) {
      const t0 = Date.now();
      try {
        const ok = await evidenceStoreRef.health();
        checks.sqlite = { ok, ms: Date.now() - t0, ...(ok ? {} : { error: 'SELECT 1 failed' }) };
      } catch (err) {
        checks.sqlite = { ok: false, ms: Date.now() - t0, error: String(err) };
      }
    }
    const allOk = Object.values(checks).every((c) => c.ok);
    if (!allOk) reply.code(503);
    return { status: allOk ? 'ready' : 'degraded', timestamp: Date.now(), checks };
  });

  // Create invocation tracker for cancellation support
  const invocationTracker = new InvocationTracker();

  // Initialize WebSocket manager BEFORE routes (injected via opts, no circular import).
  // IMPORTANT: Socket.io must attach to the SAME server Fastify listens on.
  socketManager = new SocketManager(app.server, invocationTracker);

  // F085 Phase 4: Platform-level activity tracker (hyperfocus brake)
  const activityTracker = new ActivityTracker();
  app.addHook('onRequest', (request, _reply, done) => {
    // Skip non-API paths and brake endpoints (avoid trigger-on-checkin loop)
    if (!request.url.startsWith('/api/') || request.url.startsWith('/api/brake/')) {
      done();
      return;
    }
    const userId = resolveUserId(request);
    if (userId) {
      activityTracker.recordActivity(userId);
      // shouldTrigger reads per-user settings (enabled + threshold) internally
      const level = activityTracker.shouldTrigger(userId);
      if (level > 0 && socketManager) {
        activityTracker.markTriggered(userId, level as 1 | 2 | 3);
        socketManager.emitToUser(userId, 'brake:trigger', {
          level,
          activeMinutes: Math.round(activityTracker.getState(userId).activeWorkMs / 60_000),
          nightMode: ActivityTracker.isNightMode(),
          timestamp: Date.now(),
        });
      }
    }
    done();
  });

  // Create shared service instances for MCP callback flow
  const registry = new InvocationRegistry();
  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl ? createRedisClient({ url: redisUrl }) : undefined;
  redisClient = redis ?? null;

  // Fail-closed: refuse to start without Redis unless explicitly opted into memory mode.
  // Also verify Redis is actually reachable (PING), not just configured.
  if (redis) {
    try {
      await redis.ping();
      app.log.info('[api] Redis PING OK');
    } catch (err) {
      await redis.quit().catch(() => {});
      throw new Error(
        `[api] Redis PING failed: ${err instanceof Error ? err.message : err}. ` +
          'Check REDIS_URL or set MEMORY_STORE=1 for memory mode.',
      );
    }
  }
  const storageResult = assertStorageReady(!!redis);
  app.log.info(`[api] Storage mode: ${storageResult.mode}`);

  // F102 KD-34: append listener placeholder (wired after memoryServices init)
  let appendListener: ((msg: { id: string; threadId: string; timestamp: number; content: string }) => void) | null =
    null;

  const messageStore = createMessageStore(redis, {
    onAppend: (msg) => {
      appendListener?.(msg);
    },
  });
  const sessionStore = redis ? new SessionStore(redis) : undefined;
  const deliveryCursorStore = new DeliveryCursorStore(sessionStore);
  const threadStore = createThreadStore(redis);
  // F155 B-4/B-6: Guide state is runtime-only (in-memory, resets on restart)
  const { InMemoryGuideSessionStore } = await import('./domains/guides/GuideSessionRepository.js');
  const guideSessionStore = new InMemoryGuideSessionStore();
  const { InMemoryGuideDismissTracker } = await import('./domains/guides/GuideDismissTracker.js');
  const dismissTracker = new InMemoryGuideDismissTracker();
  const taskStore = createTaskStore(redis);
  const communityIssueStore = createCommunityIssueStore(redis);
  if (redis) {
    const { RedisPrTrackingStore } = await import('./infrastructure/email/RedisPrTrackingStore.js');
    const { backfillLegacyPrTracking } = await import('./infrastructure/email/backfill-legacy-pr-tracking.js');
    await backfillLegacyPrTracking({
      legacyStore: new RedisPrTrackingStore(redis),
      taskStore,
      log: app.log,
    });
  }
  const backlogStore = createBacklogStore(redis);
  const workflowSopStore = createWorkflowSopStore(redis);
  const summaryStore = createSummaryStore(redis);
  const memoryStore = createMemoryStore(redis);
  const taskProgressStore = createTaskProgressStore(redis);
  const invocationRecordStore = createInvocationRecordStore(redis);
  const draftStore = createDraftStore(redis);
  const readStateStore = createReadStateStore(redis);
  const { ExecutionDigestStore } = await import('./domains/projects/execution-digest-store.js');
  const executionDigestStore = new ExecutionDigestStore();

  if (
    redis &&
    messageStore instanceof RedisMessageStore &&
    invocationRecordStore instanceof RedisInvocationRecordStore
  ) {
    const backfillResult = await runSchedulerReplyUserIdBackfill({
      redis,
      messageStore,
      invocationRecordStore,
      threadStore,
    });
    if (!backfillResult.skipped && (backfillResult.repairedMessages > 0 || backfillResult.repairedInvocations > 0)) {
      app.log.info(
        {
          repairedMessages: backfillResult.repairedMessages,
          repairedInvocations: backfillResult.repairedInvocations,
        },
        '[api] F139 scheduler reply userId backfill completed',
      );
    }
  }

  const sessionChainStore = createSessionChainStore(redis);
  // F24: Transcript Writer/Reader for session chain
  // E7 fix: resolve relative to monorepo root, not CWD (same fix as docsRoot in PR #524)
  const transcriptDataDir = process.env.TRANSCRIPT_DATA_DIR ?? `${findMonorepoRoot(process.cwd())}/data/transcripts`;
  const transcriptWriter = new TranscriptWriter({ dataDir: transcriptDataDir });
  const transcriptReader = new TranscriptReader({ dataDir: transcriptDataDir });
  // F065 Phase C: HandoffConfig for LLM-generated digest on seal
  const handoffConfig: HandoffConfig = {
    getBootstrapDepth: (catId: string) => getConfigSessionStrategy(catId)?.handoff?.bootstrapDepth ?? 'extractive',
    resolveProfile: async (threadId: string, catId: string) => {
      try {
        let projectRoot = findMonorepoRoot(process.cwd());
        const thread = await threadStore.get(threadId);
        if (thread?.projectPath && thread.projectPath !== 'default') {
          projectRoot = thread.projectPath;
        }
        const catConfig = catRegistry.tryGet(catId)?.config;
        if (catConfig?.clientId === 'anthropic' || catConfig?.clientId === 'opencode') {
          const effectiveAccountRef = resolveBoundAccountRefForCat(projectRoot, catId, catConfig);
          const runtime = resolveForClient(projectRoot, catConfig.clientId, effectiveAccountRef);
          if (!runtime?.apiKey) return null;
          return { apiKey: runtime.apiKey, baseUrl: runtime.baseUrl || 'https://api.anthropic.com' };
        }

        const runtime = resolveAnthropicRuntimeProfile(projectRoot);
        if (!runtime.apiKey) return null;
        return { apiKey: runtime.apiKey, baseUrl: runtime.baseUrl || 'https://api.anthropic.com' };
      } catch {
        return null;
      }
    },
  };
  const sessionSealer = new SessionSealer(
    sessionChainStore,
    transcriptWriter,
    threadStore,
    transcriptReader,
    (catId) => getCatContextBudget(catId).maxPromptTokens,
    handoffConfig,
    summaryStore,
  );

  // F102: Memory services — SQLite-only
  // P1 fix: resolve paths relative to repo root, not CWD (which may be packages/api)
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const repoRoot = existsSync(resolve(process.cwd(), 'docs', 'features'))
    ? process.cwd()
    : existsSync(resolve(process.cwd(), '..', '..', 'docs', 'features'))
      ? resolve(process.cwd(), '..', '..')
      : process.cwd();

  const { initRepoIdentity, isSameRepo } = await import('./utils/is-same-repo.js');
  initRepoIdentity(repoRoot);

  const { createMemoryServices } = await import('./domains/memory/factory.js');
  const memoryServices = await createMemoryServices({
    type: 'sqlite',
    sqlitePath: process.env.EVIDENCE_DB ?? resolve(repoRoot, 'evidence.sqlite'),
    docsRoot: process.env.DOCS_ROOT ?? resolve(repoRoot, 'docs'),
    markersDir: resolve(repoRoot, 'docs', 'markers'),
    transcriptDataDir, // reuse the same resolved path as Writer/Reader (line 282)
    // Gap-1: expose EMBED_MODE env variable (Phase C infra ready, default off for open-source)
    embed: process.env.EMBED_MODE ? { embedMode: process.env.EMBED_MODE as 'off' | 'shadow' | 'on' } : undefined,
    // Phase E-2: message passage indexing — provide a callback that reads thread messages
    messageListFn: async (threadId: string, limit?: number) => {
      const messages = await messageStore.getByThread(threadId, limit ?? 2000, 'default-user');
      return messages
        .filter((m: { origin?: string }) => m.origin !== 'briefing') // F148 Phase E (AC-E2): exclude briefing from evidence index
        .map((m: { id: string; content: string; catId?: string | null; threadId: string; timestamp: number }) => ({
          id: m.id,
          content: m.content,
          catId: m.catId ?? undefined,
          threadId: m.threadId,
          timestamp: m.timestamp,
        }));
    },
    // Phase E-1: thread summary indexing — provide a callback that lists all threads
    threadListFn: async () => {
      const threads = await threadStore.list('default-user');
      return threads
        .filter((t) => !t.projectPath.startsWith('games/'))
        .map((t) => ({
          id: t.id,
          title: t.title,
          participants: t.participants as string[],
          threadMemory: t.threadMemory ? { summary: t.threadMemory.summary } : null,
          lastActiveAt: t.lastActiveAt,
          featureIds: t.backlogItemId ? [t.backlogItemId] : undefined,
        }));
    },
    excludeThreadIdsFn: async () => {
      const allThreads = await threadStore.list('default-user');
      const excluded = new Set<string>();
      for (const t of allThreads) {
        if (t.projectPath.startsWith('games/')) excluded.add(t.id);
      }
      return excluded;
    },
  });
  // F152: Wire evidence store into /ready probe
  evidenceStoreRef = memoryServices.evidenceStore;
  app.log.info('[api] F102: SQLite memory services initialized');

  // F152 Phase B: Expedition Bootstrap — state manager + service
  const { IndexStateManager } = await import('./domains/memory/IndexStateManager.js');
  const { ExpeditionBootstrapService } = await import('./domains/memory/ExpeditionBootstrapService.js');
  const indexStateManager = new IndexStateManager(memoryServices.store.getDb());
  const { execFileSync } = await import('node:child_process');
  const getFingerprint = (projectPath: string) => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectPath, encoding: 'utf-8' }).trim();
    } catch {
      return '';
    }
  };
  const expeditionBootstrapService = new ExpeditionBootstrapService(indexStateManager, {
    rebuildIndex: async (projectPath: string) => {
      const startMs = Date.now();
      const { buildStructuralSummary } = await import('./domains/memory/ExpeditionBootstrapService.js');
      const summary = buildStructuralSummary(projectPath);
      return { docsIndexed: summary.docsList.length, durationMs: Date.now() - startMs };
    },
    getFingerprint,
    getTierCoverage: async (projectPath: string) => {
      if (!isSameRepo(projectPath, repoRoot)) return {};

      const db = memoryServices.store.getDb();
      const rows = db
        .prepare(
          `SELECT provenance_tier, COUNT(*) as cnt FROM evidence_docs WHERE provenance_tier IS NOT NULL AND source_path NOT LIKE 'archive/%' GROUP BY provenance_tier`,
        )
        .all() as Array<{ provenance_tier: string; cnt: number }>;
      const result: Record<string, number> = {};
      for (const row of rows) {
        result[row.provenance_tier] = row.cnt;
      }
      return result;
    },
    getKindCoverage: async (projectPath: string) => {
      if (!isSameRepo(projectPath, repoRoot)) return {};

      const { mapKindToSourceType } = await import('./routes/evidence-helpers.js');
      const db = memoryServices.store.getDb();
      const rows = db
        .prepare(
          `SELECT kind, COUNT(*) as cnt FROM evidence_docs WHERE kind IS NOT NULL AND source_path NOT LIKE 'archive/%' GROUP BY kind`,
        )
        .all() as Array<{ kind: string; cnt: number }>;
      const result: Record<string, number> = {};
      for (const row of rows) {
        const sourceType = mapKindToSourceType(row.kind);
        result[sourceType] = (result[sourceType] || 0) + row.cnt;
      }
      return result;
    },
  });

  // F102 D-2: Auto-rebuild evidence index on startup (AC-D4)
  if (memoryServices.indexBuilder) {
    const startMs = Date.now();
    try {
      const result = await memoryServices.indexBuilder.rebuild();
      app.log.info(
        `[api] F102: evidence index rebuilt — ${result.docsIndexed} indexed, ${result.docsSkipped} skipped (${Date.now() - startMs}ms)`,
      );
    } catch (err) {
      app.log.warn(`[api] F102: evidence index rebuild failed (non-fatal): ${err}`);
    }
  }

  // F-4: Global knowledge rebuild (Skills + MEMORY.md → global_knowledge.sqlite)
  if (memoryServices.globalIndexBuilder) {
    try {
      const gResult = await memoryServices.globalIndexBuilder.rebuild();
      app.log.info(`[api] F102: global knowledge rebuilt — ${gResult.docsIndexed} indexed (${gResult.durationMs}ms)`);
    } catch (err) {
      app.log.warn(`[api] F102: global knowledge rebuild failed (non-fatal): ${err}`);
    }
  }

  // Phase E-2: Dirty-thread debounce — flush modified thread summaries every 30s
  const DIRTY_THREAD_FLUSH_INTERVAL_MS = 30_000;
  if (memoryServices.indexBuilder) {
    const { IndexBuilder } = await import('./domains/memory/IndexBuilder.js');
    const ib = memoryServices.indexBuilder;
    if (ib instanceof IndexBuilder) {
      // F102 KD-34: Wire append listener now that memoryServices is ready.
      // This covers ALL 36 messageStore.append() call sites via the store itself,
      // replacing the old HTTP onResponse hooks that only caught 2 routes.
      appendListener = (msg) => {
        if (msg.threadId) {
          ib.markThreadDirty(msg.threadId);
          // G-3c P1 fix (砚砚 review): accumulate delta from actual new message,
          // not from rebuilt summary snapshot in flushDirtyThreads
          ib.accumulateSummaryDelta(msg.threadId, msg.content);
        }
      };

      const dirtyFlushTimer = setInterval(async () => {
        try {
          const flushed = await ib.flushDirtyThreads();
          if (flushed > 0) {
            app.log.info(`[api] F102 E-2: flushed ${flushed} dirty thread(s) to evidence index`);
          }
        } catch {
          // best-effort
        }
      }, DIRTY_THREAD_FLUSH_INTERVAL_MS);
      dirtyFlushTimer.unref();
    }
  }

  // ── F139: Unified Scheduler (TaskRunnerV2) ──
  const { TaskRunnerV2 } = await import('./infrastructure/scheduler/TaskRunnerV2.js');
  const { RunLedger } = await import('./infrastructure/scheduler/RunLedger.js');
  const { createActorResolver } = await import('./infrastructure/scheduler/ActorResolver.js');
  const { getRoster } = await import('./config/cat-config-loader.js');
  const schedulerDb = memoryServices.store.getDb();
  const runLedger = new RunLedger(schedulerDb);
  const actorResolver = createActorResolver(getRoster);
  // ── F139 Phase 3B: Governance + Emission stores ──
  const { GlobalControlStore } = await import('./infrastructure/scheduler/GlobalControlStore.js');
  const { EmissionStore } = await import('./infrastructure/scheduler/EmissionStore.js');
  const { PackTemplateStore } = await import('./infrastructure/scheduler/PackTemplateStore.js');
  const globalControlStore = new GlobalControlStore(schedulerDb);
  const emissionStore = new EmissionStore(schedulerDb);
  const packTemplateStore = new PackTemplateStore(schedulerDb);

  // Phase 4: delivery + content fetch for template execution
  const { createDeliverFn, createLifecycleToastFn } = await import('./infrastructure/scheduler/delivery.js');
  const { createFetchContentFn } = await import('./infrastructure/scheduler/content-fetcher.js');
  const schedulerDeliver = createDeliverFn({ messageStore, socketManager });
  const schedulerLifecycleToast = createLifecycleToastFn({ socketManager });
  const schedulerFetchContent = createFetchContentFn();

  const taskRunnerV2 = new TaskRunnerV2({
    logger: { info: app.log.info.bind(app.log), error: app.log.error.bind(app.log) },
    ledger: runLedger,
    actorResolver,
    globalControlStore,
    emissionStore,
    deliver: schedulerDeliver,
    notifyLifecycle: schedulerLifecycleToast,
    fetchContent: schedulerFetchContent,
  });

  // ── F139 Phase 3A: Dynamic task store + template registry ──
  const { DynamicTaskStore } = await import('./infrastructure/scheduler/DynamicTaskStore.js');
  const { templateRegistry } = await import('./infrastructure/scheduler/templates/registry.js');
  const dynamicTaskStore = new DynamicTaskStore(schedulerDb);
  taskRunnerV2.setDynamicTaskStore(dynamicTaskStore); // #415: wire store for once-trigger auto-retirement

  // ── F139 Phase 2+3A+3B: Schedule panel API routes ──
  const { scheduleRoutes } = await import('./routes/schedule.js');
  await app.register(scheduleRoutes, {
    taskRunner: taskRunnerV2,
    dynamicTaskStore,
    templateRegistry,
    globalControlStore,
    packTemplateStore,
    taskStore,
    notifyLifecycle: schedulerLifecycleToast,
    registry,
  });

  // ── Phase G: Summary Compaction (registers into unified scheduler) ──
  if (process.env.F102_ABSTRACTIVE === 'on' && memoryServices.indexBuilder) {
    try {
      const { createSummaryCompactionTaskSpec } = await import('./domains/memory/SummaryCompactionTaskSpec.js');
      const { createAbstractiveClient } = await import('./domains/memory/AbstractiveSummaryClient.js');

      // Abstractive summary API config resolution (priority order):
      // 1. F102_API_BASE + F102_API_KEY (explicit override)
      // 2. Unified accounts system (credentials.json) + local proxy
      // 3. null → skip abstractive
      const generateAbstractive = createAbstractiveClient(
        async () => {
          // Priority 1: explicit F102 config
          if (process.env.F102_API_BASE && process.env.F102_API_KEY) {
            return { mode: 'api_key' as const, baseUrl: process.env.F102_API_BASE, apiKey: process.env.F102_API_KEY };
          }
          // Priority 2: deterministic binding with installer-only fallback (502 regression)
          const runtimeProfile = resolveAnthropicRuntimeProfile(process.cwd());
          const apiKey = runtimeProfile.apiKey;
          if (!apiKey) return null;
          const proxyPort = process.env.ANTHROPIC_PROXY_PORT || '9877';
          // Read first upstream slug from proxy-upstreams.json
          try {
            const { readFileSync } = await import('fs');
            const { resolve: resolvePath } = await import('path');
            const upstreamsPath =
              process.env.ANTHROPIC_PROXY_UPSTREAMS_PATH ||
              resolvePath(process.cwd(), '.cat-cafe', 'proxy-upstreams.json');
            const upstreams = JSON.parse(readFileSync(upstreamsPath, 'utf-8'));
            const firstSlug = Object.keys(upstreams)[0];
            if (!firstSlug) return null;
            return {
              mode: 'api_key' as const,
              baseUrl: `http://127.0.0.1:${proxyPort}/${firstSlug}`,
              apiKey,
            };
          } catch {
            // No proxy config → try direct with API key
            return { mode: 'api_key' as const, baseUrl: 'https://api.anthropic.com', apiKey };
          }
        },
        { info: app.log.info.bind(app.log), error: app.log.error.bind(app.log) },
      );

      const db = memoryServices.store.getDb();
      const summarySpec = createSummaryCompactionTaskSpec({
        db,
        enabled: () => process.env.F102_ABSTRACTIVE === 'on',
        getThreadLastActivity: async (threadId) => {
          const msgs = await messageStore.getByThread(threadId, 1, 'default-user');
          if (msgs.length === 0) return null;
          return { threadId, lastMessageAt: msgs[0]!.timestamp };
        },
        getMessagesAfterWatermark: async (threadId, afterMessageId, limit) => {
          // P1 fix (砚砚 review): use getByThreadAfter for true "after watermark" semantics,
          // not "latest N + slice" which would skip messages if delta > limit
          const msgs = await messageStore.getByThreadAfter(
            threadId,
            afterMessageId ?? undefined,
            limit,
            'default-user',
          );
          return msgs.map((m) => ({
            id: m.id,
            content: m.content,
            catId: m.catId ?? undefined,
            timestamp: m.timestamp,
          }));
        },
        generateAbstractive,
        // Re-embed thread after abstractive summary update (semantic search uses vectors)
        reEmbed: memoryServices.embeddingService?.isReady()
          ? async (anchor: string, text: string) => {
              const [vec] = await memoryServices.embeddingService!.embed([text]);
              memoryServices.vectorStore?.upsert(anchor, vec);
            }
          : undefined,
        // H-3: Submit durable candidates to knowledge emergence pipeline
        // Gated by F102_DURABLE_CANDIDATES flag (spec §F102 env config)
        submitCandidate:
          process.env.F102_DURABLE_CANDIDATES !== 'on'
            ? undefined
            : async (candidate) => {
                const marker = await memoryServices.markerQueue.submit({
                  content: `[${candidate.kind}] ${candidate.title}: ${candidate.claim}`,
                  source: `thread:${candidate.threadId}`,
                  status: 'captured',
                  // method → lesson: EvidenceKind has no 'method' variant; methods are stored as lessons
                  targetKind: candidate.kind === 'decision' ? 'decision' : 'lesson',
                });
                // Auto-approve explicit candidates (铲屎官不需要每条都审)
                if (candidate.confidence === 'explicit') {
                  await memoryServices.markerQueue.transition(marker.id, 'normalized');
                  await memoryServices.markerQueue.transition(marker.id, 'approved');
                  app.log.info(`[knowledge-emergence] auto-approved: [${candidate.kind}] ${candidate.title}`);
                } else {
                  app.log.info(`[knowledge-emergence] submitted for review: [${candidate.kind}] ${candidate.title}`);
                }
              },
        logger: { info: app.log.info.bind(app.log), error: app.log.error.bind(app.log) },
      });

      taskRunnerV2.register(summarySpec);
      const candidatesOn = process.env.F102_DURABLE_CANDIDATES === 'on';
      const topicSegOn = process.env.F102_TOPIC_SEGMENTS === 'on';
      app.log.info(
        `[api] F139: summary-compact spec registered (candidates=${candidatesOn ? 'on' : 'off'}, topicSegments=${topicSegOn ? 'on' : 'off'})`,
      );

      // H-3 backfill: replay lost candidates from summary_segments into MarkerQueue.
      // Gated by F102_DURABLE_CANDIDATES (same gate as submitCandidate above).
      if (!candidatesOn) {
        app.log.info('[knowledge-backfill] skipped (F102_DURABLE_CANDIDATES=off)');
      } else {
        // Before the mkdirSync fix, submit() silently failed (ENOENT). This one-shot
        // replay recovers those candidates. Idempotent via content-based dedup: each
        // candidate is skipped if a marker with identical content already exists.
        const existingMarkers = await memoryServices.markerQueue.list();
        const existingContents = new Set(existingMarkers.map((m) => m.content));
        const rows = db
          .prepare('SELECT thread_id, candidates FROM summary_segments WHERE candidates IS NOT NULL')
          .all() as Array<{ thread_id: string; candidates: string }>;
        let backfilled = 0;
        for (const row of rows) {
          try {
            const candidates = JSON.parse(row.candidates) as Array<{
              kind: string;
              title: string;
              claim: string;
              confidence?: string;
            }>;
            for (const c of candidates) {
              const content = `[${c.kind}] ${c.title}: ${c.claim}`;
              if (existingContents.has(content)) continue;
              const marker = await memoryServices.markerQueue.submit({
                content,
                source: `thread:${row.thread_id}`,
                status: 'captured',
                targetKind: c.kind === 'decision' ? 'decision' : 'lesson',
              });
              if ((c.confidence ?? 'inferred') === 'explicit') {
                await memoryServices.markerQueue.transition(marker.id, 'normalized');
                await memoryServices.markerQueue.transition(marker.id, 'approved');
              }
              existingContents.add(content);
              backfilled++;
            }
          } catch (backfillErr) {
            app.log.error(`[knowledge-backfill] failed for thread ${row.thread_id}: ${backfillErr}`);
          }
        }
        if (backfilled > 0) {
          app.log.info(`[knowledge-backfill] replayed ${backfilled} lost candidates into MarkerQueue`);
        }
      }
    } catch (err) {
      app.log.warn(`[api] F102 Phase G: scheduler init failed (non-fatal): ${err}`);
    }
  }

  // ── F32-b/F127: Bootstrap runtime catalog, then populate CatRegistry (all variants) ──
  // Must happen BEFORE AgentRouter construction (parseMentions reads catRegistry)
  try {
    const catConfig = bootstrapDefaultCatCatalog();
    const allConfigs = toAllCatConfigs(catConfig);
    for (const [id, config] of Object.entries(allConfigs)) {
      catRegistry.register(id, config);
    }
    app.log.info(`[api] CatRegistry initialized: ${catRegistry.getAllIds().join(', ')}`);
  } catch (err) {
    app.log.warn(`[api] Failed to load cat template/catalog, falling back to built-in CAT_CONFIGS: ${String(err)}`);
    // Fallback: register from static CAT_CONFIGS
    const { CAT_CONFIGS } = await import('@cat-cafe/shared');
    for (const [id, config] of Object.entries(CAT_CONFIGS)) {
      if (!catRegistry.has(id)) catRegistry.register(id, config);
    }
  }

  // ── F149 Phase C: ACP process pool registry (variantId → AcpProcessPool) ──
  // Using Map<string, any> because AcpProcessPool is dynamically imported only when acp config present.
  // biome-ignore lint: dynamic import bridge
  const acpPoolRegistry = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  // ── F32-b: AgentRegistry (catId → AgentService) — one instance per cat ──
  // Each cat gets its own AgentService instance with its catId + model.
  const agentRegistry = new AgentRegistry();
  let router!: AgentRouter;
  const syncAgentRegistry = async (configs: Record<string, CatConfig>) => {
    agentRegistry.reset();
    for (const [id, config] of Object.entries(configs)) {
      const catId = config.id;
      // F32-b P1 fix: do NOT pass model here — let constructors resolve via
      // getCatModel(catId) which respects env override (CAT_*_MODEL > config > fallback)
      let service: AgentService;
      switch (config.clientId) {
        case 'anthropic':
          service = new ClaudeAgentService({ catId });
          break;
        case 'openai':
          service = new CodexAgentService({ catId });
          break;
        case 'google': {
          const acpConfig = getAcpConfig(id);
          if (acpConfig) {
            const { GeminiAcpAdapter } = await import(
              './domains/cats/services/agents/providers/acp/GeminiAcpAdapter.js'
            );
            const { AcpProcessPool } = await import('./domains/cats/services/agents/providers/acp/AcpProcessPool.js');
            const { AcpClient } = await import('./domains/cats/services/agents/providers/acp/AcpClient.js');
            const acpProjectRoot = findMonorepoRoot();
            const poolKey = { projectPath: acpProjectRoot, providerProfile: id };
            // Shared pool per variant — reused across cats with same variant
            if (!acpPoolRegistry.has(id)) {
              const pool = new AcpProcessPool(
                {
                  maxLiveProcesses: acpConfig.pool?.maxLiveProcesses ?? 3,
                  idleTtlMs: acpConfig.pool?.idleTtlMs ?? 5 * 60 * 1000,
                  healthCheckIntervalMs: 30_000,
                },
                acpConfig,
                () =>
                  new AcpClient({
                    command: acpConfig.command,
                    args: acpConfig.startupArgs,
                    cwd: acpProjectRoot,
                  }),
              );
              acpPoolRegistry.set(id, pool);
            }
            const { resolveAcpMcpServers } = await import(
              './domains/cats/services/agents/providers/acp/acp-mcp-resolver.js'
            );
            const mcpServers = resolveAcpMcpServers(acpProjectRoot, acpConfig.mcpWhitelist ?? []);
            service = new GeminiAcpAdapter({
              catId,
              pool: acpPoolRegistry.get(id)!,
              poolKey,
              projectRoot: acpProjectRoot,
              mcpServers,
            });
          } else {
            service = new GeminiAgentService({ catId });
          }
          break;
        }
        case 'kimi':
          service = new KimiAgentService({ catId });
          break;
        case 'dare':
          service = new DareAgentService({ catId });
          break;
        case 'antigravity':
          service = new AntigravityAgentService({
            catId,
          });
          break;
        case 'opencode':
          service = new OpenCodeAgentService({ catId });
          break;
        case 'catagent': {
          const { CatAgentService } = await import(
            './domains/cats/services/agents/providers/catagent/CatAgentService.js'
          );
          service = new CatAgentService({ catId, projectRoot: findMonorepoRoot(), catConfig: config });
          break;
        }
        case 'a2a': {
          const { A2AAgentService } = await import('./domains/cats/services/agents/providers/A2AAgentService.js');
          const envKey = `CAT_${id.toUpperCase()}_A2A_URL`;
          const a2aUrl = process.env[envKey] ?? '';
          if (!a2aUrl) {
            app.log.warn(`[api] A2A cat "${id}" missing ${envKey} env var. It will not be routable.`);
            continue;
          }
          service = new A2AAgentService({ catId, config: { url: a2aUrl } });
          break;
        }
        default:
          app.log.warn(`[api] Unknown client "${config.clientId}" for cat "${id}". It will not be routable.`);
          continue;
      }
      agentRegistry.register(id, service);
    }
    if (router) router.refreshFromRegistry(agentRegistry);
  };
  await syncAgentRegistry(catRegistry.getAllConfigs());

  // F136 Phase 3A: Cat catalog subscriber — syncs AgentRegistry when cats CRUD emits cat-config events
  const { createCatCatalogSubscriber } = await import('./config/cat-catalog-subscriber.js');
  const catCatalogSubscriber = createCatCatalogSubscriber({
    async onReconcile() {
      app.log.info('[api] F136: Cat catalog changed, syncing agent registry...');
      await syncAgentRegistry(catRegistry.getAllConfigs());
    },
    log: app.log,
  });

  // F136 Phase 4c: Account binding subscriber — rebinds provider profiles when accounts change
  const { createAccountBindingSubscriber } = await import('./config/account-binding-subscriber.js');
  const accountBindingSubscriber = createAccountBindingSubscriber({
    async onRebind(changedAccountRefs) {
      app.log.info(`[api] F136: Accounts changed [${changedAccountRefs.join(', ')}], syncing agent registry...`);
      await syncAgentRegistry(catRegistry.getAllConfigs());
    },
    log: app.log,
  });

  // F089 Phase 2: Shared instances for tmux agent pane execution (opt-in)
  const enableTmuxAgent = process.env.CAT_CAFE_TMUX_AGENT === '1';
  let tmuxGateway: TmuxGateway | undefined;
  if (enableTmuxAgent) {
    try {
      tmuxGateway = new TmuxGateway();
      app.log.info(`[tmux] enabled — binary: ${tmuxGateway.tmuxBin}`);
    } catch (err) {
      app.log.error(`[tmux] CAT_CAFE_TMUX_AGENT=1 but tmux not found: ${(err as Error).message}`);
    }
  }
  const agentPaneRegistry = tmuxGateway ? new AgentPaneRegistry() : undefined;

  // F120: Preview Gateway (独立端口反向代理) + Port Discovery
  const PREVIEW_GATEWAY_ENABLED = process.env.PREVIEW_GATEWAY_ENABLED !== '0';
  const PREVIEW_GATEWAY_PORT = Number.parseInt(process.env.PREVIEW_GATEWAY_PORT ?? '4100', 10);
  const runtimePorts = collectRuntimePorts();
  const previewGateway = new PreviewGateway({ port: PREVIEW_GATEWAY_PORT, runtimePorts });
  const portDiscovery = new PortDiscoveryService();
  if (PREVIEW_GATEWAY_ENABLED) {
    try {
      await previewGateway.start();
      app.log.info(`[preview] Gateway started on port ${previewGateway.actualPort}`);
    } catch (err) {
      app.log.warn(`[preview] Gateway failed to start: ${(err as Error).message}`);
    }
  } else {
    app.log.info('[preview] Gateway disabled (PREVIEW_GATEWAY_ENABLED=0)');
  }
  // Port discovery → Socket.IO push to worktree-scoped room
  portDiscovery.onDiscovered((port) => {
    if (socketManager) {
      const room = port.worktreeId ? `worktree:${port.worktreeId}` : 'preview:global';
      socketManager.broadcastToRoom(room, 'preview:port-discovered', port);
    }
  });

  // F129: Pack store — shared between router (invocation) and routes (API)
  const { PackStore } = await import('./domains/packs/PackStore.js');
  const packStoreDir = join(findMonorepoRoot(process.cwd()), '.cat-cafe', 'packs');
  const packStore = new PackStore(packStoreDir);

  // F150: Tool usage counter (fire-and-forget INCR on tool_use events)
  const toolUsageArchiver = redis
    ? new (await import('./domains/cats/services/tool-usage/ToolUsageArchiver.js')).ToolUsageArchiver(
        join(findMonorepoRoot(process.cwd()), '.cat-cafe', 'tool-usage-archive.jsonl'),
      )
    : undefined;
  const toolUsageCounter = redis
    ? new (await import('./domains/cats/services/tool-usage/ToolUsageCounter.js')).ToolUsageCounter(
        redis,
        toolUsageArchiver,
      )
    : undefined;

  // F150: Daily archive sweep — persist expiring Redis counters to JSONL
  if (toolUsageCounter && toolUsageArchiver) {
    const sweepLog = (await import('./infrastructure/logger.js')).createModuleLogger('tool-usage-sweep');
    let sweepInFlight = false;
    const runSweep = async () => {
      if (sweepInFlight) return;
      sweepInFlight = true;
      try {
        const archivedDates = await toolUsageArchiver.getArchivedDates();
        // Catch-up: archive ALL unarchived dates older than 7 days (not just 85-89).
        // Covers downtime gaps — any date still in Redis but not yet archived gets saved.
        const now = new Date();
        const targetDates = new Set<string>();
        for (let offset = 7; offset <= 89; offset++) {
          const d = new Date(now);
          d.setDate(d.getDate() - offset);
          const dateStr = d.toISOString().slice(0, 10);
          if (!archivedDates.has(dateStr)) targetDates.add(dateStr);
        }
        if (targetDates.size === 0) return;
        // Single SCAN for all dates, then filter client-side
        const allEntries = await toolUsageCounter.fetchAllEntries();
        let archived = 0;
        for (const date of targetDates) {
          const entries = allEntries.filter((e) => e.date === date);
          if (entries.length > 0) {
            archived += await toolUsageArchiver.archiveEntries(entries);
          }
        }
        if (archived > 0) sweepLog.info({ archived }, 'Tool usage archive sweep completed');
      } catch (err) {
        sweepLog.warn({ err }, 'Tool usage archive sweep failed');
      } finally {
        sweepInFlight = false;
      }
    };
    // First sweep 30s after startup, then daily
    const startupTimer = setTimeout(runSweep, 30_000);
    startupTimer.unref();
    const dailyTimer = setInterval(runSweep, 24 * 60 * 60 * 1000);
    dailyTimer.unref();
  }

  // Shared AgentRouter — used by messagesRoutes and invocationsRoutes
  router = new AgentRouter({
    agentRegistry,
    registry,
    messageStore,
    taskProgressStore,
    ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
    ...(sessionStore ? { sessionStore } : {}),
    ...(threadStore ? { threadStore } : {}),
    sessionChainStore,
    transcriptWriter,
    transcriptReader,
    sessionSealer,
    draftStore,
    taskStore,
    ...(workflowSopStore ? { workflowSopStore } : {}),
    executionDigestStore,
    socketManager,
    ...(tmuxGateway ? { tmuxGateway } : {}),
    ...(agentPaneRegistry ? { agentPaneRegistry } : {}),
    signalArticleLookup: createSignalArticleLookup({ transcriptReader }),
    packStore,
    evidenceStore: memoryServices.evidenceStore,
    ...(toolUsageCounter ? { toolUsageCounter } : {}),
    guideSessionStore,
    dismissTracker,
  });

  // F39: Message queue delivery
  const invocationQueue = new InvocationQueue();
  const queueProcessor = new QueueProcessor({
    queue: invocationQueue,
    invocationTracker,
    invocationRecordStore: invocationRecordStore as unknown as InvocationRecordStoreLike,
    router: router as unknown as RouterLike,
    socketManager,
    messageStore,
    log: app.log,
  });
  socketManager.setQueueProcessor(queueProcessor);

  // F101: Game engine store (created early so messages route can intercept /game commands)
  const { RedisGameStore } = await import('./domains/cats/services/stores/redis/RedisGameStore.js');
  const f101GameStore = redis ? new RedisGameStore(redis) : undefined;

  // F101 Phase I: Shared ActionNotifier + game driver (narrator or legacy).
  // Created early so both messagesRoutes and gameRoutes use the same driver instance.
  const { EventEmitterActionNotifier } = await import('./domains/cats/services/game/EventEmitterActionNotifier.js');
  const sharedActionNotifier = new EventEmitterActionNotifier();
  let f101SharedDriver: import('./domains/cats/services/game/GameDriver.js').GameDriver | undefined;
  if (f101GameStore) {
    const gameNarratorEnabled = process.env.GAME_NARRATOR_ENABLED === 'true';
    const { GameOrchestrator } = await import('./domains/cats/services/game/GameOrchestrator.js');
    const sharedOrchestrator = new GameOrchestrator({ gameStore: f101GameStore, socketManager, messageStore });
    const { createGameDriver } = await import('./domains/cats/services/game/createGameDriver.js');
    if (gameNarratorEnabled) {
      const { createWakeCatFn } = await import('./domains/cats/services/game/wakeCatImpl.js');
      const wakeCat = createWakeCatFn({
        threadStore,
        invocationQueue,
        queueProcessor,
        log: app.log,
      });
      f101SharedDriver = createGameDriver({
        gameNarratorEnabled: true,
        legacyDeps: { gameStore: f101GameStore, orchestrator: sharedOrchestrator, messageStore },
        narratorDeps: {
          gameStore: f101GameStore,
          wakeCat,
          actionNotifier: sharedActionNotifier,
          orchestrator: sharedOrchestrator,
          messageStore,
          socketManager,
        },
      });
      app.log.info('[api] F101 game driver: GameNarratorDriver (agent-driven)');
    } else {
      f101SharedDriver = createGameDriver({
        gameNarratorEnabled: false,
        legacyDeps: { gameStore: f101GameStore, orchestrator: sharedOrchestrator, messageStore },
      });
      app.log.info('[api] F101 game driver: LegacyAutoDriver');
    }
  }

  // Register routes (socketManager injected, no circular import)
  const messagesOpts = {
    registry,
    messageStore,
    socketManager,
    router,
    deliveryCursorStore,
    ...(sessionStore ? { sessionStore } : {}),
    threadStore,
    invocationTracker,
    invocationRecordStore,
    summaryStore,
    draftStore,
    invocationQueue,
    queueProcessor,
    ...(f101GameStore ? { gameStore: f101GameStore } : {}),
    ...(f101SharedDriver ? { autoPlayer: f101SharedDriver } : {}),
  };
  await app.register(messagesRoutes, messagesOpts);
  await app.register(queueRoutes, {
    threadStore,
    invocationQueue,
    queueProcessor,
    invocationTracker,
    socketManager,
    messageStore, // F117: for marking queued messages as canceled on withdraw/clear
  });
  await app.register(invocationsRoutes, {
    invocationRecordStore,
    messageStore,
    socketManager,
    router,
    invocationTracker,
    queueProcessor,
  });
  await app.register(messageActionsRoutes, {
    messageStore,
    socketManager,
    threadStore,
  });
  // F155: Frontend-facing guide actions (no MCP auth, uses userId header)
  if (threadStore) {
    await app.register(guideActionRoutes, {
      threadStore,
      socketManager,
      guideSessionStore,
      dismissTracker,
    });
  }
  await app.register(catsRoutes);

  // F149 Phase C: ACP pool diagnostics endpoint (gated by env flag)
  app.get('/api/diagnostics/acp-pool', async (_req, reply) => {
    if (process.env.CAT_CAFE_DIAGNOSTICS !== '1') {
      return reply.code(403).send({ error: 'Diagnostics disabled' });
    }
    const pools: Record<string, unknown> = {};
    for (const [variantId, pool] of acpPoolRegistry) {
      pools[variantId] = pool.getMetrics();
    }
    return { pools, poolCount: acpPoolRegistry.size };
  });

  await app.register(quotaRoutes);
  // F128: Daily token usage aggregation
  await app.register(usageRoutes, { invocationRecordStore });
  // F150: Tool/Skill/MCP usage statistics
  if (toolUsageCounter) {
    await app.register(toolUsageRoutes, { toolUsageCounter });
  }
  // F075 Phase B+C: Game + Achievement stores
  const { GameStore } = await import('./domains/leaderboard/game-store.js');
  const { AchievementStore } = await import('./domains/leaderboard/achievement-store.js');
  const gameStore = new GameStore();
  const achievementStore = new AchievementStore();
  await app.register(leaderboardRoutes, { messageStore, gameStore, achievementStore });
  await app.register(leaderboardEventsRoutes, { gameStore, achievementStore });
  await app.register(bootcampRoutes, { threadStore });
  const connectorHubOpts: Parameters<typeof connectorHubRoutes>[1] = { threadStore };
  await app.register(connectorHubRoutes, connectorHubOpts);
  await app.register(brakeRoutes, { activityTracker });

  // F101: Game routes (store created earlier for /game command interception)
  if (f101GameStore) {
    await app.register(gameRoutes, {
      gameStore: f101GameStore,
      socketManager,
      threadStore,
      messageStore,
      ...(f101SharedDriver ? { autoPlayer: f101SharedDriver } : {}),
    });

    const { gameActionRoutes, clearGameNonces } = await import('./routes/game-actions.js');
    const { GameOrchestrator } = await import('./domains/cats/services/game/GameOrchestrator.js');
    const actionOrchestrator = new GameOrchestrator({
      gameStore: f101GameStore,
      socketManager,
      messageStore,
      onGameEnd: (gameId) => clearGameNonces(gameId),
    });
    await app.register(gameActionRoutes, {
      gameStore: f101GameStore,
      orchestrator: actionOrchestrator,
      threadStore,
      actionNotifier: sharedActionNotifier,
    });

    app.log.info('[api] F101 game routes registered');
  }

  // Phase D (AC-D1): validate repo exists via `gh repo view` before PR tracking registration.
  // Generic — works for any GitHub repo the caller has access to, not hardcoded to ours.
  // Cloud P1: distinguish "repo not found" (return false) from infra failure (throw).
  const validateRepo = async (repoFullName: string): Promise<boolean> => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync('gh', ['repo', 'view', repoFullName, '--json', 'name'], { timeout: 10_000 });
      return true;
    } catch (err: unknown) {
      // gh ran but repo not found/no access → process exit code is a number
      if (err instanceof Error && 'code' in err && typeof (err as Record<string, unknown>).code === 'number') {
        return false;
      }
      // Infrastructure failure (gh not found, timeout, auth broken) → propagate
      throw err;
    }
  };

  // F126: Create LimbRegistry + Phase B deps for device/hardware capability management
  const { LimbRegistry } = await import('./domains/limb/LimbRegistry.js');
  const { LimbAccessPolicy } = await import('./domains/limb/LimbAccessPolicy.js');
  const { LimbLeaseManager } = await import('./domains/limb/LimbLeaseManager.js');
  const { LimbActionLog } = await import('./domains/limb/LimbActionLog.js');
  const limbRegistry = new LimbRegistry();
  limbRegistry.setDeps({
    accessPolicy: new LimbAccessPolicy(),
    leaseManager: new LimbLeaseManager(),
    actionLog: new LimbActionLog(),
  });

  // F126 Phase C: Pairing store + limb node routes for remote devices
  const { LimbPairingStore } = await import('./domains/limb/LimbPairingStore.js');
  const { registerLimbNodeRoutes } = await import('./routes/limb-node-routes.js');
  const limbPairingStore = new LimbPairingStore();
  registerLimbNodeRoutes(app, { limbRegistry, pairingStore: limbPairingStore });

  const callbackOpts = {
    registry,
    messageStore,
    socketManager,
    taskStore,
    backlogStore,
    threadStore,
    agentRegistry,
    router,
    invocationRecordStore,
    invocationTracker,
    deliveryCursorStore,
    validateRepo,
    ...(workflowSopStore ? { workflowSopStore } : {}),
    queueProcessor,
    invocationQueue,
    evidenceStore: memoryServices.evidenceStore,
    markerQueue: memoryServices.markerQueue,
    reflectionService: memoryServices.reflectionService,
    limbRegistry,
    limbPairingStore,
    guideSessionStore,
  } as Parameters<typeof callbacksRoutes>[1];
  await app.register(callbacksRoutes, callbackOpts);

  // Authorization system — 猫猫动态权限 (Redis-backed when available)
  const authRuleStore = createAuthorizationRuleStore(redis);
  const authPendingStore = createPendingRequestStore(redis);
  const authAuditStore = createAuthorizationAuditStore(redis);
  const authManager = new AuthorizationManager({
    ruleStore: authRuleStore,
    pendingStore: authPendingStore,
    auditStore: authAuditStore,
    io: socketManager.getIO(),
  });
  await app.register(callbackAuthRoutes, { authManager, registry });
  await app.register(authorizationRoutes, {
    authManager,
    ruleStore: authRuleStore,
    auditStore: authAuditStore,
    socketManager,
  });
  await app.register(threadsRoutes, {
    threadStore,
    messageStore,
    taskStore,
    memoryStore,
    deliveryCursorStore,
    invocationTracker,
    draftStore,
    taskProgressStore,
    backlogStore,
    ...(readStateStore ? { readStateStore } : {}),
    guideSessionStore,
  });
  await app.register(threadBranchRoutes, {
    threadStore,
    messageStore,
    socketManager,
  });
  await app.register(threadExportRoutes, { threadStore });
  // F142: shared connector binding store — reused by threadCatsRoutes AND connector gateway
  const { RedisConnectorThreadBindingStore } = await import(
    './infrastructure/connectors/RedisConnectorThreadBindingStore.js'
  );
  const { MemoryConnectorThreadBindingStore } = await import(
    './infrastructure/connectors/ConnectorThreadBindingStore.js'
  );
  const connectorBindingStore = redisClient
    ? new RedisConnectorThreadBindingStore(redisClient)
    : new MemoryConnectorThreadBindingStore();
  {
    const allCatConfigs = catRegistry.getAllConfigs();
    await app.register(threadCatsRoutes, {
      threadStore,
      agentRegistry,
      bindingStore: connectorBindingStore,
      getCatDisplayName: (catId: string) => allCatConfigs[catId]?.displayName ?? catId,
      getAllCatIds: () => Object.keys(allCatConfigs),
      isCatAvailable: (catId: string) => isCatAvailable(catId),
    });
  }
  await app.register(tasksRoutes, { taskStore, socketManager });
  await app.register(communityIssueRoutes, { communityIssueStore, taskStore, socketManager });
  await app.register(backlogRoutes, { backlogStore, threadStore, messageStore });

  // F076: External projects + Need Audit
  const { ExternalProjectStore } = await import('./domains/projects/external-project-store.js');
  const { IntentCardStore } = await import('./domains/projects/intent-card-store.js');
  const { NeedAuditFrameStore } = await import('./domains/projects/need-audit-frame-store.js');
  const externalProjectStore = new ExternalProjectStore();
  const intentCardStore = new IntentCardStore();
  const needAuditFrameStore = new NeedAuditFrameStore();
  const { ResolutionStore } = await import('./domains/projects/resolution-store.js');
  const { SliceStore } = await import('./domains/projects/slice-store.js');
  const { RefluxPatternStore } = await import('./domains/projects/reflux-pattern-store.js');
  const resolutionStore = new ResolutionStore();
  const sliceStore = new SliceStore();
  const refluxPatternStore = new RefluxPatternStore();
  await app.register(externalProjectRoutes, { externalProjectStore, needAuditFrameStore, backlogStore });
  await app.register(intentCardRoutes, { externalProjectStore, intentCardStore });
  await app.register(resolutionRoutes, { externalProjectStore, resolutionStore });
  await app.register(sliceRoutes, { externalProjectStore, sliceStore });
  await app.register(refluxRoutes, { externalProjectStore, refluxPatternStore });
  await app.register(executionDigestRoutes, { executionDigestStore });
  if (workflowSopStore) {
    await app.register(workflowSopRoutes, { workflowSopStore, backlogStore });
  }
  await app.register(summariesRoutes, { summaryStore, socketManager });
  await app.register(projectsRoutes);
  await app.register(mkdirRoute);
  await app.register(governanceStatusRoute);
  await app.register(projectSetupRoute, {
    memoryBootstrapService: expeditionBootstrapService as { bootstrap: (p: string, o?: unknown) => Promise<unknown> },
    socketManager: socketManager ?? undefined,
  });
  await app.register(projectsBootstrapRoutes, {
    stateManager: indexStateManager,
    bootstrapService: expeditionBootstrapService,
    socketManager: socketManager!,
    getFingerprint,
  });
  await app.register(exportRoutes, { messageStore, threadStore });
  await app.register(configRoutes);
  await app.register(configSecretsRoutes);
  await app.register(featureDocDetailRoutes);
  await app.register(accountsRoutes);
  await app.register(claudeRescueRoutes);
  await app.register(auditRoutes, { threadStore });
  await app.register(capabilitiesRoutes);

  {
    const { createAdapterRegistry } = await import('./marketplace/index.js');
    const { loadClaudeCatalog, loadCodexCatalog, loadOpenClawCatalog, loadAntigravityCatalog } = await import(
      './marketplace/catalog-loaders.js'
    );
    const registry = createAdapterRegistry({
      claude: { catalogLoader: loadClaudeCatalog },
      codex: { catalogLoader: loadCodexCatalog },
      openclaw: { catalogLoader: loadOpenClawCatalog },
      antigravity: { catalogLoader: loadAntigravityCatalog },
    });
    await app.register(marketplaceRoutes, { registry });
  }

  await app.register(workspaceRoutes, {
    socketEmit: (event, data, room) => {
      socketManager?.broadcastToRoom(room, event, data);
    },
  });
  await app.register(workspaceEditRoutes);
  await app.register(workspaceGitRoutes);
  await app.register(terminalRoutes, {
    ...(tmuxGateway ? { tmuxGateway } : {}),
    ...(agentPaneRegistry ? { agentPaneRegistry } : {}),
    portDiscovery,
  });
  await app.register(previewRoutes, {
    portDiscovery,
    gatewayPort: PREVIEW_GATEWAY_ENABLED ? previewGateway.actualPort || PREVIEW_GATEWAY_PORT : 0,
    runtimePorts,
    socketEmit: (event, data, room) => {
      socketManager?.broadcastToRoom(room, event, data);
    },
  });
  await app.register(skillsRoutes);
  await app.register(memoryRoutes, { memoryStore, threadStore });

  // Session chain (F24)
  await app.register(sessionChainRoutes, {
    sessionChainStore,
    threadStore,
    messageStore,
    transcriptReader,
    sessionSealer,
  });
  await app.register(sessionTranscriptRoutes, { sessionChainStore, threadStore, transcriptReader });
  const hookToken = process.env.CAT_CAFE_HOOK_TOKEN || '';
  await app.register(sessionHooksRoutes, {
    sessionChainStore,
    sessionSealer,
    transcriptReader,
    ...(hookToken ? { hookToken } : {}),
  });

  // F33 Phase 3: Session strategy config (runtime overrides via Redis)
  if (redis) {
    try {
      await initRuntimeOverrides(redis);
      app.log.info('[api] Session strategy runtime overrides hydrated from Redis');
    } catch (err) {
      app.log.warn(
        `[api] Session strategy hydration failed (best-effort, continuing with empty cache): ${String(err)}`,
      );
    }
  }
  await app.register(sessionStrategyConfigRoutes);

  // Voting system (F079)
  const { voteRoutes } = await import('./routes/votes.js');
  await app.register(voteRoutes, { threadStore, socketManager, messageStore });

  // Evidence search (SQLite) + reindex endpoint (D-11) + F-4 federated search
  await app.register(evidenceRoutes, {
    evidenceStore: memoryServices.evidenceStore,
    indexBuilder: memoryServices.indexBuilder,
    knowledgeResolver: memoryServices.knowledgeResolver,
  });

  // F163: Knowledge promotion admin API (localhost-only)
  const { f163AdminRoutes } = await import('./routes/f163-admin.js');
  await app.register(f163AdminRoutes, {
    evidenceStore: memoryServices.evidenceStore as unknown as Parameters<typeof f163AdminRoutes>[1]['evidenceStore'],
  });

  // F163 Phase C: Knowledge audit routes (contradiction check, flag-review, review-queue, health-report)
  const { f163AuditRoutes } = await import('./routes/f163-audit-routes.js');
  await app.register(f163AuditRoutes, {
    evidenceStore: memoryServices.evidenceStore as unknown as Parameters<typeof f163AuditRoutes>[1]['evidenceStore'],
  });

  // F152 Phase C: Distillation routes (global lesson reflow)
  if (memoryServices.globalStore) {
    const { DistillationService } = await import('./domains/memory/distillation-service.js');
    const distillationService = new DistillationService(memoryServices.store, memoryServices.globalStore);
    await distillationService.initialize();
    await app.register(distillationRoutes, {
      evidenceStore: memoryServices.evidenceStore,
      distillationService,
    });
  }

  // F129: Pack system routes (reuse shared packStore from above)
  {
    const { PackSecurityGuard } = await import('./domains/packs/PackSecurityGuard.js');
    const { PackLoader } = await import('./domains/packs/PackLoader.js');
    const packGuard = new PackSecurityGuard();
    const packLoader = new PackLoader(packStore, packGuard);
    const root = findMonorepoRoot(process.cwd());
    await app.register(packsRoutes, {
      packLoader,
      catConfigPath: join(root, 'cat-config.json'),
      sharedRulesPath: join(root, 'cat-cafe-skills', 'refs', 'shared-rules.md'),
      skillsManifestPath: join(root, 'cat-cafe-skills', 'manifest.yaml'),
    });
  }

  // Reflect (SQLite-backed reflection)
  await app.register(reflectRoutes, {
    reflectionService: memoryServices.reflectionService,
  });

  // Phase H: Knowledge Emergence Feed API
  await knowledgeFeedRoutes(app, {
    markerQueue: memoryServices.markerQueue,
    db: memoryServices.store.getDb(),
    materializationService: memoryServices.materializationService,
  });

  // Memory governance (publish workflow)
  const governanceStore = new MemoryGovernanceStore();
  await app.register(memoryPublishRoutes, { governanceStore });

  // F142-B: Build unified command registry at startup (AC-B5)
  const commandRegistry = new CommandRegistry(CORE_COMMANDS);
  const skillsDir = join(findMonorepoRoot(process.cwd()), 'cat-cafe-skills');
  const skillCommandMap = await parseManifestSlashCommands(skillsDir);
  for (const [skillId, cmds] of skillCommandMap) {
    commandRegistry.registerSkillCommands(
      skillId,
      cmds.map((c) => ({
        ...c,
        usage: c.usage ?? c.name,
        source: 'skill' as const,
        category: 'connector',
        skillId,
      })),
      app.log,
    );
  }
  app.log.info(
    `[api] F142-B: CommandRegistry loaded (${commandRegistry.getAll().length} commands, ${skillCommandMap.size} skills)`,
  );

  // Commands route needs opus service for task extraction
  const opusService = new ClaudeAgentService();
  await app.register(commandsRoutes, {
    messageStore,
    taskStore,
    socketManager,
    opusService,
    threadStore,
    registry: commandRegistry,
  });
  await app.register(signalsRoutes);
  await app.register(signalStudyRoutes, { threadStore });
  await app.register(signalCollectionRoutes);
  await app.register(signalPodcastRoutes, {
    messageStore,
    threadStore,
    router,
    invocationRecordStore,
    invocationTracker,
  });

  // Serve uploaded files (images)
  const uploadDir = process.env.UPLOAD_DIR ?? './uploads';
  await app.register(uploadsRoutes, { uploadDir });

  // F088: Serve downloaded connector media files
  const connectorMediaDir = process.env.CONNECTOR_MEDIA_DIR ?? './data/connector-media';
  await app.register(connectorMediaRoutes, { mediaDir: connectorMediaDir });

  // F34: TTS Provider (mlx-audio → Python TTS server)
  const ttsRegistry = new TtsRegistry();
  const ttsUrl = process.env.TTS_URL ?? 'http://localhost:9879';
  ttsRegistry.register(new MlxAudioTtsProvider({ baseUrl: ttsUrl }));
  const ttsCacheDir = process.env.TTS_CACHE_DIR ?? './data/tts-cache';
  await app.register(ttsRoutes, { ttsRegistry, cacheDir: ttsCacheDir });
  initVoiceBlockSynthesizer(ttsRegistry, ttsCacheDir);
  initStreamingTtsRegistry(ttsRegistry);
  startTtsCacheCleaner(ttsCacheDir);

  // C1+C2: Web Push Notifications (optional — requires VAPID keys)
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? '';
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? '';
  const vapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:cat-cafe@localhost';
  const pushSubscriptionStore = createPushSubscriptionStore(redis);
  const pushService =
    vapidPublicKey && vapidPrivateKey
      ? initPushNotificationService({
          subscriptionStore: pushSubscriptionStore,
          vapidPublicKey,
          vapidPrivateKey,
          vapidSubject,
        })
      : null;
  if (pushService) {
    app.log.info('[api] Web Push enabled (VAPID configured)');
  } else {
    app.log.info('[api] Web Push disabled (VAPID keys not set)');
  }
  await app.register(pushRoutes, { pushSubscriptionStore, pushService, vapidPublicKey });

  // F-BLOAT: Progressive disclosure docs endpoints (no auth, static content)
  await app.register(registerCallbackDocsRoutes);

  // GitHub Review Watcher stores + routes (BACKLOG #81)
  // Must register routes BEFORE app.listen()
  const processedEmailStore = new MemoryProcessedEmailStore();
  const reviewRouter = new ReviewRouter({
    taskStore,
    processedEmailStore,
    threadStore,
    messageStore,
    socketManager,
    log: app.log,
    defaultUserId: 'default-user',
    reviewContentFetcher: new GhCliReviewContentFetcher(app.log),
  });

  // F088: Register connector webhook routes BEFORE listen (Fastify requires it)
  const connectorWebhookHandlers = new Map<string, import('./routes/connector-webhooks.js').ConnectorWebhookHandler>();
  await app.register(connectorWebhookRoutes, { handlers: connectorWebhookHandlers });

  let apiInstanceLease: ApiInstanceLease | undefined;
  let shutdownForLeaseLoss: ((signal: string) => Promise<void>) | null = null;
  let forcedLeaseLossExitTimer: ReturnType<typeof setTimeout> | null = null;
  const handleLeaseInvalidation = (event: ApiInstanceLeaseInvalidation): void => {
    const errorDetail = event.error ? ` error=${String(event.error)}` : '';
    app.log.error(
      `[api] API namespace lease invalidated (${event.reason}) for ${event.holder.instanceId} pid=${event.holder.pid} host=${event.holder.hostname} port=${event.holder.apiPort}; shutting down to preserve Redis singleton.${errorDetail}`,
    );
    if (!forcedLeaseLossExitTimer) {
      forcedLeaseLossExitTimer = setTimeout(() => {
        app.log.error('[api] Lease-loss shutdown timed out; forcing process exit');
        process.exit(1);
      }, 5_000);
      forcedLeaseLossExitTimer.unref?.();
    }
    if (shutdownForLeaseLoss) {
      void shutdownForLeaseLoss(`API_INSTANCE_LEASE_${event.reason.toUpperCase()}`);
      return;
    }
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  };
  if (redis) {
    apiInstanceLease = new ApiInstanceLease(redis, {
      apiPort: PORT,
      cwd: process.cwd(),
      startedAt: PROCESS_START_AT,
      onLeaseInvalidated: handleLeaseInvalidation,
    });
    const leaseResult = await apiInstanceLease.acquire();
    if (!leaseResult.acquired) {
      await apiInstanceLease.release().catch(() => {});
      await redis.quit().catch(() => {});
      const holder = leaseResult.holder;
      const holderHint = holder
        ? ` holder=${holder.instanceId} pid=${holder.pid} host=${holder.hostname} port=${holder.apiPort}`
        : '';
      throw new Error(`[api] Redis namespace already has a live API instance; refusing to start.${holderHint}`);
    }
    app.log.info(
      `[api] API namespace lease acquired (${leaseResult.holder?.instanceId ?? 'unknown'}) on redis=${redisUrl ?? 'memory'}`,
    );
  }

  // F149 Phase C: graceful shutdown for ACP process pools
  app.addHook('onClose', async () => {
    for (const pool of acpPoolRegistry.values()) {
      await pool.closeAll();
    }
    acpPoolRegistry.clear();
  });

  // F101: register onClose hook BEFORE listen (Fastify forbids addHook after listen).
  // The actual recovery player is assigned post-listen; stopAllLoops is a no-op if null.
  let f101RecoveryPlayer: { stopAllLoops(): void } | null = null;
  app.addHook('onClose', async () => {
    f101RecoveryPlayer?.stopAllLoops();
  });

  // Start listening
  let address: string;
  try {
    address = await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    await apiInstanceLease?.release().catch(() => {});
    throw err;
  }
  app.log.info(`[api] Server running on ${address}`);
  app.log.info(`[ws] WebSocket server ready`);

  // F156: Friendly hint for private network access
  if (HOST === '0.0.0.0' && process.env.CORS_ALLOW_PRIVATE_NETWORK !== 'true') {
    app.log.warn(
      '[network] 检测到监听所有网络 (0.0.0.0)，但私网设备访问未开启。' +
        '手机/平板通过局域网或 Tailscale 访问可能被拦截。' +
        '在 .env 中添加 CORS_ALLOW_PRIVATE_NETWORK=true 并重启服务（参考 .env.example）',
    );
  }

  // F048 Phase A: Sweep orphaned invocations from previous process crash.
  // Runs only after the API has both:
  // 1) acquired the Redis namespace lease, and
  // 2) successfully bound its HTTP port.
  // This prevents a second worktree/runtime instance from sweeping another
  // live process that happens to share the same Redis namespace.
  if (redis) {
    const { StartupReconciler } = await import('./domains/cats/services/agents/invocation/StartupReconciler.js');
    const reconciler = new StartupReconciler({
      invocationRecordStore,
      taskProgressStore,
      log: app.log,
      processStartAt: PROCESS_START_AT,
      messageStore,
      socketManager: socketManager ?? undefined,
    });
    try {
      await reconciler.reconcileOrphans();
    } catch (err) {
      app.log.warn(`[api] Startup sweep failed (best-effort): ${String(err)}`);
    }
  }

  // F118 Hardening: Global session reaper — startup sweep + periodic scan.
  // Reconciles sessions stuck in 'sealing' state that the per-invoke lazy
  // reaper would never visit (e.g., threads with no subsequent invocations).
  const GLOBAL_REAPER_INTERVAL_MS = 5 * 60_000;
  try {
    const startupReaped = await sessionSealer.reconcileAllStuck();
    if (startupReaped > 0) {
      app.log.info(`[api] F118 global reaper: reconciled ${startupReaped} stuck sealing session(s) at startup`);
    }
  } catch (err) {
    app.log.warn(`[api] F118 global reaper startup sweep failed (best-effort): ${String(err)}`);
  }
  const globalReaperTimer = setInterval(async () => {
    try {
      const reaped = await sessionSealer.reconcileAllStuck();
      if (reaped > 0) {
        app.log.info(`[api] F118 global reaper: reconciled ${reaped} stuck sealing session(s)`);
      }
    } catch {
      // best-effort periodic reaper
    }
  }, GLOBAL_REAPER_INTERVAL_MS);
  globalReaperTimer.unref();

  // Log server startup to audit log (best-effort: don't crash if audit dir unwritable)
  const auditLog = getEventAuditLog();
  try {
    await auditLog.append({
      type: AuditEventTypes.SERVER_STARTED,
      data: { address, port: PORT, host: HOST, redis: redisClient ? 'connected' : 'memory' },
    });
  } catch (err) {
    app.log.warn(`[api] Audit log write failed (best-effort): ${String(err)}`);
  }

  // Best-effort: regenerate CLI configs at startup so .gemini/settings.json
  // always has the latest env placeholders (Gemini MCP env injection)
  try {
    const root = process.cwd();
    const capConfig = await readCapabilitiesConfig(root);
    if (capConfig) {
      await generateCliConfigs(capConfig, {
        anthropic: join(root, '.mcp.json'),
        openai: join(root, '.codex', 'config.toml'),
        google: join(root, '.gemini', 'settings.json'),
        kimi: join(root, '.kimi', 'mcp.json'),
      });
      app.log.info('[api] CLI configs regenerated at startup');
    }
  } catch (err) {
    app.log.warn(`[api] CLI config regeneration failed (best-effort): ${String(err)}`);
  }

  // clowder-ai#340: Account startup — fail-fast (LL-043 / migration conflict / corrupt credentials).
  // Errors propagate to main().catch → process.exit(1).
  {
    const { accountStartupHook } = await import('./config/account-startup.js');
    const startupResult = accountStartupHook(findMonorepoRoot(process.cwd()));
    app.log.info(`[api] clowder-ai#340 accounts: ${startupResult.accountCount} account(s) loaded`);
  }

  // F101 Phase G: Recover auto-play loops for active games after restart.
  if (f101GameStore && socketManager && f101SharedDriver) {
    f101RecoveryPlayer = f101SharedDriver;
    try {
      const recovered = await f101SharedDriver.recoverActiveGames();
      if (recovered > 0) {
        app.log.info(`[api] F101 auto-play recovery: restored ${recovered} active game loop(s)`);
      }
    } catch (err) {
      app.log.warn(`[api] F101 auto-play recovery failed (best-effort): ${String(err)}`);
    }
  }

  // Phase 3b: connector invoke trigger (auto-invoke cat after review email routing)
  const frontendBaseUrl = resolveFrontendBaseUrl(process.env, app.log);
  const invokeTrigger = new ConnectorInvokeTrigger({
    router,
    socketManager,
    invocationRecordStore,
    invocationTracker,
    invocationQueue,
    queueProcessor,
    threadMetaLookup: async (threadId) => {
      const thread = await threadStore.get(threadId);
      if (!thread) return undefined;
      return {
        threadShortId: threadId.slice(0, 15),
        threadTitle: thread.title ?? undefined,
        deepLinkUrl: `${frontendBaseUrl}/threads/${threadId}`,
      };
    },
    log: app.log,
  });

  // F140: Shared feedback filter (Rule C) — used by BOTH email watcher and API polling
  const { createGitHubFeedbackFilter } = await import('./infrastructure/email/github-feedback-filter.js');
  let selfGitHubLogin: string | undefined;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('gh', ['api', '/user', '--jq', '.login'], { timeout: 10_000 });
    selfGitHubLogin = stdout.trim() || undefined;
    app.log.info(`[api] F140: feedback filter self=${selfGitHubLogin}`);
  } catch {
    app.log.warn('[api] F140: could not resolve GitHub login — self-filter disabled');
  }
  const authoritativeLogins = (process.env.GITHUB_AUTHORITATIVE_REVIEW_LOGINS || 'chatgpt-codex-connector[bot]')
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);
  const feedbackFilter = createGitHubFeedbackFilter({
    selfGitHubLogin,
    authoritativeReviewLogins: authoritativeLogins,
  });
  app.log.info(`[api] F140: authoritative review logins=${authoritativeLogins.join(', ')}`);

  // Start email watcher AFTER listen (non-blocking, best-effort)
  await startGithubReviewWatcher({
    log: app.log,
    reviewRouter,
    invokeTrigger,
    feedbackFilter,
  });

  // F139 Phase 4b: late-bind invokeTrigger so templates can wake cats
  taskRunnerV2.setInvokeTrigger(invokeTrigger);

  // F139: Register PR-related TaskSpecs into unified scheduler
  {
    const { createCiCdCheckTaskSpec } = await import('./infrastructure/email/CiCdCheckTaskSpec.js');
    const { createConflictCheckTaskSpec } = await import('./infrastructure/email/ConflictCheckTaskSpec.js');
    const { createReviewFeedbackTaskSpec } = await import('./infrastructure/email/ReviewFeedbackTaskSpec.js');

    const deliveryDeps = { messageStore, socketManager };

    const cicdRouter = new CiCdRouter({
      taskStore,
      deliveryDeps,
      log: app.log,
    });

    // F140: ConflictRouter (state-transition dedup + KD-9 fingerprint reset)
    const conflictRouter = new ConflictRouter({
      taskStore,
      deliveryDeps,
      log: app.log,
    });

    // F140: ReviewFeedbackRouter (three-section aggregated messages)
    const reviewFeedbackRouter = new ReviewFeedbackRouter({
      deliveryDeps,
      log: app.log,
    });

    taskRunnerV2.register(createCiCdCheckTaskSpec({ taskStore, cicdRouter, invokeTrigger, log: app.log }));

    // F140: conflict-check with ConflictRouter + urgent trigger
    const checkMergeable = async (repo: string, pr: number) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'view', String(pr), '-R', repo, '--json', 'mergeable,headRefOid'],
        { timeout: 15_000 },
      );
      const data = JSON.parse(stdout);
      // Use `mergeable` (CONFLICTING/MERGEABLE/UNKNOWN) — not `mergeStateStatus` (DIRTY/CLEAN/...)
      // ConflictRouter checks for exact string 'CONFLICTING'
      return { mergeState: data.mergeable ?? 'UNKNOWN', headSha: data.headRefOid ?? '' };
    };

    const { ConflictAutoExecutor } = await import('./infrastructure/email/ConflictAutoExecutor.js');
    const autoExecutor = new ConflictAutoExecutor({ log: app.log });

    taskRunnerV2.register(
      createConflictCheckTaskSpec({
        taskStore,
        checkMergeable,
        conflictRouter,
        invokeTrigger,
        autoExecutor,
        log: app.log,
      }),
    );

    // F140: review-feedback with ReviewFeedbackRouter (KD-11 replaces review-comments)
    // feedbackFilter already created above (shared with email watcher — Rule C)

    const fetchPaginated = async (endpoint: string) => {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('gh', ['api', endpoint, '--paginate', '--jq', '.[]'], {
        timeout: 30_000,
      });
      if (!stdout.trim()) return [];
      return stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    };

    taskRunnerV2.register(
      createReviewFeedbackTaskSpec({
        taskStore,
        fetchComments: async (repo, pr) => {
          const [reviewComments, issueComments] = await Promise.all([
            fetchPaginated(`/repos/${repo}/pulls/${pr}/comments`),
            fetchPaginated(`/repos/${repo}/issues/${pr}/comments`),
          ]);
          return [...reviewComments, ...issueComments].map(
            (c: {
              id: number;
              body: string;
              created_at: string;
              user?: { login: string };
              path?: string;
              line?: number;
              pull_request_review_id?: number;
            }) => ({
              id: c.id,
              author: c.user?.login ?? 'unknown',
              body: c.body,
              createdAt: c.created_at,
              commentType: c.pull_request_review_id ? ('inline' as const) : ('conversation' as const),
              ...(c.path ? { filePath: c.path } : {}),
              ...(c.line ? { line: c.line } : {}),
            }),
          );
        },
        fetchReviews: async (repo, pr) => {
          const reviews = await fetchPaginated(`/repos/${repo}/pulls/${pr}/reviews`);
          return reviews.map(
            (r: { id: number; user?: { login: string }; state: string; body: string; submitted_at: string }) => ({
              id: r.id,
              author: r.user?.login ?? 'unknown',
              state: r.state as 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED' | 'COMMENTED',
              body: r.body,
              submittedAt: r.submitted_at,
            }),
          );
        },
        reviewFeedbackRouter,
        invokeTrigger,
        log: app.log,
        // Unified feedback filter (Rule A: self-authored, Rule B: authoritative review bot)
        isEchoComment: (c) => feedbackFilter.shouldSkipComment(c),
        isEchoReview: (r) => feedbackFilter.shouldSkipReview(r),
      }),
    );
    app.log.info('[api] F139/F140: cicd-check, conflict-check, review-feedback specs registered');
  }

  // F141 Phase B: Reconciliation scan —补偿 webhook 漏掉的 open PRs/Issues
  {
    const ghRepoAllowlist = process.env.GITHUB_REPO_ALLOWLIST;
    const ghInboxCatId = process.env.GITHUB_REPO_INBOX_CAT_ID;

    if (ghRepoAllowlist && ghInboxCatId && redisClient) {
      const { createRepoScanTaskSpec } = await import(
        './infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js'
      );
      const { ReconciliationDedup } = await import(
        './infrastructure/connectors/github-repo-event/ReconciliationDedup.js'
      );
      const { deliverConnectorMessage } = await import('./infrastructure/email/deliver-connector-message.js');
      const { RedisConnectorThreadBindingStore } = await import(
        './infrastructure/connectors/RedisConnectorThreadBindingStore.js'
      );

      const reconciliationDedup = new ReconciliationDedup(
        redisClient as import('./infrastructure/connectors/github-repo-event/ReconciliationDedup.js').ReconciliationRedisLike,
      );

      const allowlist = ghRepoAllowlist.split(',').map((r: string) => r.trim());

      const fetchGhApi = async (args: string[]): Promise<string> => {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync('gh', args, { timeout: 30_000 });
        return stdout;
      };

      const fetchOpenPRs = async (repo: string) => {
        const stdout = await fetchGhApi([
          'api',
          `/repos/${repo}/pulls`,
          '--jq',
          '.[] | {number, title, html_url, user: .user.login, author_association, draft}',
          '--paginate',
        ]);
        if (!stdout.trim()) return [];
        return stdout
          .trim()
          .split('\n')
          .map((line: string) => JSON.parse(line));
      };

      const fetchOpenIssues = async (repo: string) => {
        const stdout = await fetchGhApi([
          'api',
          `/repos/${repo}/issues`,
          '--jq',
          '.[] | select(.pull_request == null) | {number, title, html_url, user: .user.login, author_association}',
          '--paginate',
        ]);
        if (!stdout.trim()) return [];
        return stdout
          .trim()
          .split('\n')
          .map((line: string) => JSON.parse(line));
      };

      const { getOwnerUserId } = await import('./config/cat-config-loader.js');
      const effectiveUserId = getOwnerUserId();

      taskRunnerV2.register(
        createRepoScanTaskSpec({
          repoAllowlist: allowlist,
          inboxCatId: ghInboxCatId,
          defaultUserId: effectiveUserId,
          reconciliationDedup,
          bindingStore: new RedisConnectorThreadBindingStore(redisClient),
          deliverFn: deliverConnectorMessage,
          deliveryDeps: { messageStore, socketManager },
          invokeTrigger,
          fetchOpenPRs,
          fetchOpenIssues,
          log: app.log,
        }),
      );
      app.log.info('[api] F141 Phase B: repo-scan spec registered');
    }
  }

  // F139 Phase 3B: Hydrate pack templates from SQLite into TemplateRegistry
  const packDefs = packTemplateStore.listAll();
  let packHydrated = 0;
  for (const def of packDefs) {
    const builtin = templateRegistry.get(def.builtinTemplateRef);
    if (builtin) {
      templateRegistry.register({
        templateId: def.templateId,
        label: def.label,
        category: def.category,
        description: def.description,
        subjectKind: def.subjectKind,
        defaultTrigger: def.defaultTrigger,
        paramSchema:
          def.paramSchema as import('./infrastructure/scheduler/templates/types.js').TaskTemplate['paramSchema'],
        createSpec: builtin.createSpec,
      });
      packHydrated++;
    }
  }
  if (packHydrated > 0) app.log.info(`[api] F139: hydrated ${packHydrated} pack template(s)`);

  // F139 Phase 3A: Hydrate dynamic tasks from SQLite before starting
  const hydrated = taskRunnerV2.hydrateDynamic(dynamicTaskStore, templateRegistry);
  if (hydrated > 0) app.log.info(`[api] F139: hydrated ${hydrated} dynamic task(s)`);

  // F139: Start unified scheduler (all registered specs)
  taskRunnerV2.start();
  app.log.info(`[api] F139: unified scheduler started (${taskRunnerV2.getRegisteredTasks().join(', ')})`);

  // F088: Start connector gateway (best-effort, after listen)
  const gatewayDeps = {
    messageStore: {
      async append(input: Parameters<typeof messageStore.append>[0]) {
        const result = await messageStore.append(input);
        return { id: result.id };
      },
      async getById(id: string) {
        const msg = messageStore.getById?.(id);
        if (!msg) return null;
        const resolved = msg instanceof Promise ? await msg : msg;
        return resolved ? { source: resolved.source } : null;
      },
    },
    threadStore,
    invokeTrigger,
    socketManager,
    defaultUserId: 'default-user' as const,
    defaultCatId: 'opus' as CatId,
    redis: redisClient ?? undefined,
    log: app.log,
    agentRegistry,
    commandRegistry,
    bindingStore: connectorBindingStore,
    frontendBaseUrl,
  };

  /** Re-wire all hook consumers after gateway (re)start */
  function wireGatewayHooks(handle: NonNullable<Awaited<ReturnType<typeof startConnectorGateway>>>): void {
    invokeTrigger.setOutboundHook(handle.outboundHook);
    invokeTrigger.setStreamingHook(handle.streamingHook);
    queueProcessor.setOutboundHook(handle.outboundHook as Parameters<typeof queueProcessor.setOutboundHook>[0]);
    queueProcessor.setStreamingHook(handle.streamingHook as Parameters<typeof queueProcessor.setStreamingHook>[0]);
    (callbackOpts as { outboundHook?: typeof handle.outboundHook }).outboundHook = handle.outboundHook;
    (messagesOpts as { outboundHook?: typeof handle.outboundHook }).outboundHook = handle.outboundHook;
    (messagesOpts as { streamingHook?: typeof handle.streamingHook }).streamingHook = handle.streamingHook;
    // P1-1 fix: clear stale handlers before re-populating (hot-reload may remove connectors)
    connectorWebhookHandlers.clear();
    for (const [id, handler] of handle.webhookHandlers) {
      connectorWebhookHandlers.set(id, handler);
    }
    (connectorHubOpts as { weixinAdapter?: unknown }).weixinAdapter = handle.weixinAdapter;
    (connectorHubOpts as { startWeixinPolling?: () => void }).startWeixinPolling = handle.startWeixinPolling;
    // F132 Phase E: WeCom Bot dynamic start/stop
    (
      connectorHubOpts as { startWeComBotStream?: (botId: string, secret: string) => Promise<void> }
    ).startWeComBotStream = handle.startWeComBotStream;
    (connectorHubOpts as { stopWeComBot?: () => Promise<void> }).stopWeComBot = handle.stopWeComBot;
    // F132 bugfix: live health getter for status endpoint
    (connectorHubOpts as { getWeComBotAdapter?: () => unknown }).getWeComBotAdapter = handle.getWeComBotAdapter;
    (connectorHubOpts as { permissionStore?: unknown }).permissionStore = handle.permissionStore;
  }

  let connectorGatewayHandle: Awaited<ReturnType<typeof startConnectorGateway>> = null;
  let connectorReloadUnsub: (() => void) | null = null;
  try {
    const gatewayConfig = loadConnectorGatewayConfig();
    connectorGatewayHandle = await startConnectorGateway(gatewayConfig, gatewayDeps);
    if (connectorGatewayHandle) {
      wireGatewayHooks(connectorGatewayHandle);
      queueProcessor.setThreadMetaLookup(async (threadId) => {
        const thread = await threadStore.get(threadId);
        if (!thread) return undefined;
        return {
          threadShortId: threadId.slice(0, 15),
          threadTitle: thread.title ?? undefined,
          deepLinkUrl: `${frontendBaseUrl}/threads/${threadId}`,
        };
      });

      app.log.info('[api] Connector gateway started');
    }
  } catch (err) {
    app.log.warn(`[api] Connector gateway startup failed (best-effort): ${String(err)}`);
  }

  // F136 Phase 2: Always subscribe — enables self-healing when initial startup fails (P1-2)
  const reloadSubscriber = createConnectorReloadSubscriber({
    log: app.log,
    debounceMs: 500,
    async onRestart() {
      app.log.info('[api] F136: Hot-reloading connector gateway...');
      const newHandle = await restartConnectorGateway(connectorGatewayHandle, async () => {
        const freshConfig = loadConnectorGatewayConfig();
        return startConnectorGateway(freshConfig, gatewayDeps);
      });
      if (newHandle) {
        connectorGatewayHandle = newHandle;
        wireGatewayHooks(newHandle);
      }
      app.log.info('[api] F136: Connector gateway hot-reload complete');
    },
  });
  connectorReloadUnsub = () => reloadSubscriber.unsubscribe();
  app.log.info('[api] Connector hot-reload subscriber active');

  // Graceful shutdown handler: persist Redis before exit
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      app.log.info(`[api] Received ${signal} while shutdown already in progress`);
      return;
    }
    shuttingDown = true;

    let exitCode = 0;
    try {
      app.log.info(`[api] Received ${signal}, shutting down gracefully...`);

      // Log shutdown to audit log FIRST (before any cleanup that might fail)
      try {
        await auditLog.append({
          type: AuditEventTypes.SERVER_SHUTDOWN,
          data: { signal, graceful: true },
        });
      } catch {
        // Audit log write failed, but continue with shutdown
      }

      // Trigger Redis BGSAVE to persist in-memory data before exit
      if (redisClient) {
        try {
          app.log.info('[api] Triggering Redis BGSAVE before shutdown...');
          await redisClient.bgsave();
          // Give Redis a moment to start the background save
          await new Promise((r) => setTimeout(r, 500));
          app.log.info('[api] Redis BGSAVE triggered');
        } catch (err) {
          app.log.error(`[api] Redis BGSAVE failed: ${String(err)}`);
        }
      }

      // Stop GitHub review watcher
      try {
        await stopGithubReviewWatcher();
      } catch (err) {
        app.log.error(`[api] GithubReviewWatcher stop failed: ${String(err)}`);
      }

      taskRunnerV2.stop();

      // Stop event bus subscribers
      catCatalogSubscriber.unsubscribe();
      accountBindingSubscriber.unsubscribe();
      connectorReloadUnsub?.();
      try {
        await connectorGatewayHandle?.stop();
      } catch (err) {
        app.log.error(`[api] ConnectorGateway stop failed: ${String(err)}`);
      }

      // Stop preview gateway (F120)
      try {
        await previewGateway.stop();
      } catch (err) {
        app.log.error(`[api] PreviewGateway stop failed: ${String(err)}`);
      }

      // Close WebSocket connections
      try {
        socketManager?.close();
      } catch (err) {
        exitCode = 1;
        app.log.error(`[api] SocketManager close failed: ${String(err)}`);
      }

      // F152: Flush and shutdown OTel SDK before closing server
      try {
        await shutdownTelemetry();
      } catch (err) {
        app.log.error(`[api] OTel shutdown failed: ${String(err)}`);
      }

      // Close Fastify server
      await app.close();

      try {
        await apiInstanceLease?.release();
      } catch (err) {
        exitCode = 1;
        app.log.error(`[api] API namespace lease release failed: ${String(err)}`);
      }

      app.log.info('[api] Shutdown complete');
    } catch (err) {
      exitCode = 1;
      app.log.error(`[api] Shutdown failed: ${String(err)}`);
    } finally {
      if (forcedLeaseLossExitTimer) {
        clearTimeout(forcedLeaseLossExitTimer);
        forcedLeaseLossExitTimer = null;
      }
      process.exit(exitCode);
    }
  };
  shutdownForLeaseLoss = shutdown;

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err) => {
  console.error('[api] Fatal error:', err);
  process.exit(1);
});
