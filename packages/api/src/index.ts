/**
 * Cat Cafe API Server
 * 后端 API 入口
 */

import { join } from 'node:path';
import { type CatConfig, type CatId, catRegistry } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createRedisClient, SessionStore } from '@cat-cafe/shared/utils';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { generateCliConfigs, readCapabilitiesConfig } from './config/capabilities/capability-orchestrator.js';
import { resolveBoundAccountRefForCat } from './config/cat-account-binding.js';
import { getCatContextBudget } from './config/cat-budgets.js';
import { bootstrapDefaultCatCatalog, getConfigSessionStrategy, toAllCatConfigs } from './config/cat-config-loader.js';
import { resolveFrontendBaseUrl, resolveFrontendCorsOrigins } from './config/frontend-origin.js';
import { resolveAnthropicRuntimeProfile, resolveRuntimeProviderProfileForClient } from './config/provider-profiles.js';
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
  MemoryGovernanceStore,
  OpenCodeAgentService,
} from './domains/cats/services/index.js';
import { AutoSummarizer } from './domains/cats/services/orchestration/AutoSummarizer.js';
import { initPushNotificationService } from './domains/cats/services/push/PushNotificationService.js';
import type { HandoffConfig } from './domains/cats/services/session/SessionSealer.js';
import { SessionSealer } from './domains/cats/services/session/SessionSealer.js';
import { TranscriptReader } from './domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from './domains/cats/services/session/TranscriptWriter.js';
import { createAuthorizationAuditStore } from './domains/cats/services/stores/factories/AuthorizationAuditStoreFactory.js';
import { createAuthorizationRuleStore } from './domains/cats/services/stores/factories/AuthorizationRuleStoreFactory.js';
import { createBacklogStore } from './domains/cats/services/stores/factories/BacklogStoreFactory.js';
import { createMemoryStore } from './domains/cats/services/stores/factories/MemoryStoreFactory.js';
import { createMessageStore } from './domains/cats/services/stores/factories/MessageStoreFactory.js';
import { createPendingRequestStore } from './domains/cats/services/stores/factories/PendingRequestStoreFactory.js';
import { createPushSubscriptionStore } from './domains/cats/services/stores/factories/PushSubscriptionStoreFactory.js';
import { createReadStateStore } from './domains/cats/services/stores/factories/ReadStateStoreFactory.js';
import { createSummaryStore } from './domains/cats/services/stores/factories/SummaryStoreFactory.js';
import { createTaskStore } from './domains/cats/services/stores/factories/TaskStoreFactory.js';
import { createThreadStore } from './domains/cats/services/stores/factories/ThreadStoreFactory.js';
import { createWorkflowSopStore } from './domains/cats/services/stores/factories/WorkflowSopStoreFactory.js';
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
import {
  loadConnectorGatewayConfig,
  startConnectorGateway,
} from './infrastructure/connectors/connector-gateway-bootstrap.js';
import {
  CiCdRouter,
  ConnectorInvokeTrigger,
  GhCliReviewContentFetcher,
  MemoryProcessedEmailStore,
  MemoryPrTrackingStore,
  RedisPrTrackingStore,
  ReviewRouter,
  startGithubCiPoller,
  startGithubReviewWatcher,
  stopGithubCiPoller,
  stopGithubReviewWatcher,
} from './infrastructure/email/index.js';
import { SocketManager } from './infrastructure/websocket/index.js';
import { connectorWebhookRoutes } from './routes/connector-webhooks.js';
import { gameRoutes } from './routes/games.js';
import {
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
  configRoutes,
  connectorHubRoutes,
  connectorMediaRoutes,
  evidenceRoutes,
  executionDigestRoutes,
  exportRoutes,
  externalProjectRoutes,
  featureDocDetailRoutes,
  intentCardRoutes,
  invocationsRoutes,
  leaderboardEventsRoutes,
  leaderboardRoutes,
  memoryPublishRoutes,
  memoryRoutes,
  messageActionsRoutes,
  messagesRoutes,
  projectsRoutes,
  providerProfilesRoutes,
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
  threadsRoutes,
  ttsRoutes,
  uploadsRoutes,
  usageRoutes,
  workflowSopRoutes,
  workspaceEditRoutes,
  workspaceGitRoutes,
  workspaceRoutes,
} from './routes/index.js';
import { prTrackingRoutes } from './routes/pr-tracking.js';
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
  const { logger: customLogger } = await import('./infrastructure/logger.js');
  const app = Fastify({ logger: customLogger as unknown as import('fastify').FastifyBaseLogger });

  // CORS for frontend
  await app.register(cors, {
    origin: resolveFrontendCorsOrigins(process.env, app.log),
    credentials: true,
  });

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
  const taskStore = createTaskStore(redis);
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
        if (catConfig?.provider === 'anthropic' || catConfig?.provider === 'opencode') {
          const boundAccountRef = resolveBoundAccountRefForCat(
            projectRoot,
            catId,
            catConfig as CatConfig & { providerProfileId?: string },
          );
          const runtime = await resolveRuntimeProviderProfileForClient(
            projectRoot,
            catConfig.provider,
            boundAccountRef,
          );
          if (!runtime?.apiKey) return null;
          return { apiKey: runtime.apiKey, baseUrl: runtime.baseUrl || 'https://api.anthropic.com' };
        }

        const runtime = await resolveAnthropicRuntimeProfile(projectRoot);
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

  const { createMemoryServices } = await import('./domains/memory/factory.js');
  const memoryServices = await createMemoryServices({
    type: 'sqlite',
    sqlitePath: process.env.EVIDENCE_DB ?? resolve(repoRoot, 'evidence.sqlite'),
    docsRoot: process.env.DOCS_ROOT ?? resolve(repoRoot, 'docs'),
    transcriptDataDir, // reuse the same resolved path as Writer/Reader (line 282)
    // Gap-1: expose EMBED_MODE env variable (Phase C infra ready, default off for open-source)
    embed: process.env.EMBED_MODE ? { embedMode: process.env.EMBED_MODE as 'off' | 'shadow' | 'on' } : undefined,
    // Phase E-2: message passage indexing — provide a callback that reads thread messages
    messageListFn: async (threadId: string, limit?: number) => {
      const messages = await messageStore.getByThread(threadId, limit ?? 2000, 'default-user');
      return messages.map(
        (m: { id: string; content: string; catId?: string | null; threadId: string; timestamp: number }) => ({
          id: m.id,
          content: m.content,
          catId: m.catId ?? undefined,
          threadId: m.threadId,
          timestamp: m.timestamp,
        }),
      );
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
  app.log.info('[api] F102: SQLite memory services initialized');

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

  // ── Phase G: Summary Compaction Scheduler ──
  if (process.env.F102_ABSTRACTIVE === 'on' && memoryServices.indexBuilder) {
    try {
      const { TaskRunner } = await import('./infrastructure/scheduler/TaskRunner.js');
      const { createSummaryCompactionTask } = await import('./domains/memory/SummaryCompactionTask.js');
      const { createAbstractiveClient } = await import('./domains/memory/AbstractiveSummaryClient.js');

      const taskRunner = new TaskRunner({ info: app.log.info.bind(app.log), error: app.log.error.bind(app.log) });

      // Abstractive summary API config resolution (priority order):
      // 1. F102_API_BASE + F102_API_KEY (explicit override)
      // 2. ANTHROPIC_API_KEY + local proxy (http://127.0.0.1:{ANTHROPIC_PROXY_PORT}/{first-slug})
      // 3. null → skip abstractive
      const generateAbstractive = createAbstractiveClient(
        async () => {
          // Priority 1: explicit F102 config
          if (process.env.F102_API_BASE && process.env.F102_API_KEY) {
            return { mode: 'api_key' as const, baseUrl: process.env.F102_API_BASE, apiKey: process.env.F102_API_KEY };
          }
          // Priority 2: use existing ANTHROPIC_API_KEY + local proxy
          const apiKey = process.env.ANTHROPIC_API_KEY;
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
      const summaryTask = createSummaryCompactionTask({
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
        logger: { info: app.log.info.bind(app.log), error: app.log.error.bind(app.log) },
      });

      taskRunner.register(summaryTask);
      taskRunner.start();
      app.log.info('[api] F102 Phase G: summary compaction scheduler started');
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
      switch (config.provider) {
        case 'anthropic':
          service = new ClaudeAgentService({ catId });
          break;
        case 'openai':
          service = new CodexAgentService({ catId });
          break;
        case 'google':
          service = new GeminiAgentService({ catId });
          break;
        case 'dare':
          service = new DareAgentService({ catId });
          break;
        case 'antigravity':
          service = new AntigravityAgentService({
            catId,
            commandArgs: config.commandArgs,
          });
          break;
        case 'opencode':
          service = new OpenCodeAgentService({ catId });
          break;
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
          app.log.warn(`[api] Unknown provider "${config.provider}" for cat "${id}". It will not be routable.`);
          continue;
      }
      agentRegistry.register(id, service);
    }
    if (router) router.refreshFromRegistry(agentRegistry);
  };
  await syncAgentRegistry(catRegistry.getAllConfigs());

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
  });

  const autoSummarizer = new AutoSummarizer({ messageStore, summaryStore });

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
    autoSummarizer,
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
  await app.register(catsRoutes, { onCatalogChanged: syncAgentRegistry });
  await app.register(quotaRoutes);
  // F128: Daily token usage aggregation
  await app.register(usageRoutes, { invocationRecordStore });
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

  // TD091: Create prTrackingStore early so callbacks can use it for MCP registration
  const prTrackingStore = redis ? new RedisPrTrackingStore(redis) : new MemoryPrTrackingStore();
  app.log.info(`[api] PrTrackingStore: ${redis ? 'Redis' : 'Memory'}`);

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
    router,
    invocationRecordStore,
    invocationTracker,
    deliveryCursorStore,
    prTrackingStore,
    ...(workflowSopStore ? { workflowSopStore } : {}),
    queueProcessor,
    invocationQueue,
    evidenceStore: memoryServices.evidenceStore,
    markerQueue: memoryServices.markerQueue,
    reflectionService: memoryServices.reflectionService,
    limbRegistry,
    limbPairingStore,
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
  await app.register(callbackAuthRoutes, { registry, authManager });
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
  });
  await app.register(threadBranchRoutes, {
    threadStore,
    messageStore,
    socketManager,
  });
  await app.register(threadExportRoutes, { threadStore });
  await app.register(tasksRoutes, { taskStore, socketManager });
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
  await app.register(exportRoutes, { messageStore, threadStore });
  await app.register(configRoutes);
  await app.register(featureDocDetailRoutes);
  await app.register(providerProfilesRoutes);
  await app.register(claudeRescueRoutes);
  await app.register(auditRoutes, { threadStore });
  await app.register(capabilitiesRoutes);
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

  // Evidence search (SQLite) + reindex endpoint (D-11)
  await app.register(evidenceRoutes, {
    evidenceStore: memoryServices.evidenceStore,
    indexBuilder: memoryServices.indexBuilder,
  });

  // Reflect (SQLite-backed reflection)
  await app.register(reflectRoutes, {
    reflectionService: memoryServices.reflectionService,
  });

  // Memory governance (publish workflow)
  const governanceStore = new MemoryGovernanceStore();
  await app.register(memoryPublishRoutes, { governanceStore });

  // Commands route needs opus service for task extraction
  const opusService = new ClaudeAgentService();
  await app.register(commandsRoutes, {
    messageStore,
    taskStore,
    socketManager,
    opusService,
    threadStore,
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
    prTrackingStore,
    processedEmailStore,
    threadStore,
    messageStore,
    socketManager,
    log: app.log,
    defaultUserId: 'default-user',
    reviewContentFetcher: new GhCliReviewContentFetcher(app.log),
  });
  await app.register(prTrackingRoutes, { prTrackingStore });

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
      });
      app.log.info('[api] CLI configs regenerated at startup');
    }
  } catch (err) {
    app.log.warn(`[api] CLI config regeneration failed (best-effort): ${String(err)}`);
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

  // Start email watcher AFTER listen (non-blocking, best-effort)
  await startGithubReviewWatcher({
    log: app.log,
    reviewRouter,
    invokeTrigger,
  });

  // F133: Start CI/CD check poller (best-effort, after listen)
  const cicdRouter = new CiCdRouter({
    prTrackingStore,
    deliveryDeps: { messageStore, socketManager },
    log: app.log,
  });
  startGithubCiPoller({
    prTrackingStore,
    cicdRouter,
    invokeTrigger,
    log: app.log,
  });

  // F088: Start connector gateway (best-effort, after listen)
  let connectorGatewayHandle: Awaited<ReturnType<typeof startConnectorGateway>> = null;
  try {
    const gatewayConfig = loadConnectorGatewayConfig();
    connectorGatewayHandle = await startConnectorGateway(gatewayConfig, {
      messageStore: {
        async append(input) {
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
      defaultUserId: 'default-user',
      defaultCatId: 'opus' as CatId,
      redis: redisClient ?? undefined,
      log: app.log,
    });
    if (connectorGatewayHandle) {
      invokeTrigger.setOutboundHook(connectorGatewayHandle.outboundHook);
      invokeTrigger.setStreamingHook(connectorGatewayHandle.streamingHook);
      queueProcessor.setOutboundHook(
        connectorGatewayHandle.outboundHook as Parameters<typeof queueProcessor.setOutboundHook>[0],
      );
      queueProcessor.setStreamingHook(
        connectorGatewayHandle.streamingHook as Parameters<typeof queueProcessor.setStreamingHook>[0],
      );
      // Wire outbound delivery for proactive cat messages (post_message callback)
      (callbackOpts as { outboundHook?: typeof connectorGatewayHandle.outboundHook }).outboundHook =
        connectorGatewayHandle.outboundHook;
      // F088 ISSUE-15: Wire outbound delivery for web immediate path (messages route)
      (messagesOpts as { outboundHook?: typeof connectorGatewayHandle.outboundHook }).outboundHook =
        connectorGatewayHandle.outboundHook;
      (messagesOpts as { streamingHook?: typeof connectorGatewayHandle.streamingHook }).streamingHook =
        connectorGatewayHandle.streamingHook;
      queueProcessor.setThreadMetaLookup(async (threadId) => {
        const thread = await threadStore.get(threadId);
        if (!thread) return undefined;
        return {
          threadShortId: threadId.slice(0, 15),
          threadTitle: thread.title ?? undefined,
          deepLinkUrl: `${frontendBaseUrl}/threads/${threadId}`,
        };
      });
      for (const [id, handler] of connectorGatewayHandle.webhookHandlers) {
        connectorWebhookHandlers.set(id, handler);
      }
      // F137: Wire WeChat adapter to hub routes for QR login
      (connectorHubOpts as { weixinAdapter?: unknown }).weixinAdapter = connectorGatewayHandle.weixinAdapter;
      (connectorHubOpts as { startWeixinPolling?: () => void }).startWeixinPolling =
        connectorGatewayHandle.startWeixinPolling;
      // F134 Phase D: Wire permission store to hub routes
      (connectorHubOpts as { permissionStore?: unknown }).permissionStore = connectorGatewayHandle.permissionStore;
      app.log.info('[api] Connector gateway started');
    }
  } catch (err) {
    app.log.warn(`[api] Connector gateway startup failed (best-effort): ${String(err)}`);
  }

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

      stopGithubCiPoller();

      // Stop connector gateway
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
