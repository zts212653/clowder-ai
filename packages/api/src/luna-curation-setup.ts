import { catRegistry } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { readCurationPreference, saveCurationPreference } from './config/user-preferences-curation.js';
import type { AgentRegistry } from './domains/cats/services/agents/registry/AgentRegistry.js';
import type { IMessageStore } from './domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from './domains/cats/services/stores/ports/ThreadStore.js';
import { canAccessThread } from './domains/guides/guide-state-access.js';
import type { SummaryAttempt } from './domains/memory/abstractive-summary-types.js';
import { readCurationBatch } from './domains/memory/CurationMessageReader.js';
import { ThreadOverviewBackfill } from './domains/memory/curation/ThreadOverviewBackfill.js';
import { ThreadOverviewRepository } from './domains/memory/curation/ThreadOverviewRepository.js';
import { resolveCurationProvider } from './domains/memory/curation-provider.js';
import { type CurationProvider, createLunaCurationClient } from './domains/memory/LunaCurationClient.js';
import { ensureMemoryOperationsThread } from './domains/memory/MemoryOperationsThread.js';
import { createSummaryCompactionTaskSpec } from './domains/memory/SummaryCompactionTaskSpec.js';
import { reconcileSummaryPendingInput } from './domains/memory/summary-pending-input.js';
import type { TaskRunnerV2 } from './infrastructure/scheduler/TaskRunnerV2.js';
import type { DeliverOpts } from './infrastructure/scheduler/types.js';
import { memoryCurationRoutes } from './routes/memory-curation.js';

export async function registerLunaCuration(deps: {
  app: FastifyInstance;
  db: Database.Database;
  runExclusive?: <T>(fn: () => T) => Promise<T>;
  projectRoot: string;
  ownerUserId: string;
  householdTimeZone: string;
  agentRegistry: AgentRegistry;
  taskRunner: Pick<TaskRunnerV2, 'register'>;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  reEmbed: (anchor: string, text: string) => Promise<void>;
  deliver: (opts: DeliverOpts) => Promise<string>;
  resolveProvider?: (catId: string) => CurationProvider;
}) {
  const { app, db, projectRoot, ownerUserId, messageStore, threadStore } = deps;
  const preference = () => readCurationPreference(projectRoot);
  if (preference().enabled && preference().startedAt === null)
    saveCurationPreference(projectRoot, db, { enabled: true });
  if (preference().enabled) await ensureMemoryOperationsThread(threadStore, ownerUserId);
  const overviewRepository = new ThreadOverviewRepository({ db, ownerUserId, threadStore, messageStore });
  const generateAbstractive = createLunaCurationClient({
    resolveService: () => {
      const catId = preference().curatorCatId;
      deps.agentRegistry.get(catId);
      return deps.resolveProvider?.(catId) ?? resolveCurationProvider(projectRoot, catId);
    },
    db,
    ownerUserId,
    isSourceReadable: (threadId, messageId) => overviewRepository.isSourceReadable(threadId, messageId),
    workingDirectory: projectRoot,
    logger: { info: app.log.info.bind(app.log), error: app.log.error.bind(app.log) },
  });
  const recordAttempt = async (attempt: SummaryAttempt) => {
    app.log.info(attempt, '[F321] native overview usage and latency');
    const threadId = await ensureMemoryOperationsThread(threadStore, ownerUserId);
    await deps.deliver({
      threadId,
      userId: 'scheduler',
      content: `记忆整理：1 个对话，${attempt.messageCount} 条消息。输入 ${attempt.inputTokens ?? '未知'}，输出 ${attempt.outputTokens ?? '未知'}，缓存读取 ${attempt.cacheReadTokens ?? '未知'} token；${attempt.elapsedMs ?? '未知'} ms。${attempt.success ? '' : '本次未提交，待重试。'}`,
    });
  };
  const backfill = new ThreadOverviewBackfill({
    repository: overviewRepository,
    generate: generateAbstractive,
    onAttempt: recordAttempt,
    liveSinceMs: () => preference().startedAt,
    runExclusive: deps.runExclusive,
  });
  if (preference().enabled) await backfill.initialize();
  if (preference().enabled) {
    // Restart can miss a fire-and-forget timeline notification; recheck canonical input once.
    const markDirty = () =>
      db
        .prepare(`UPDATE summary_state SET pending_message_count=MAX(pending_message_count,1),
      pending_input_revision=pending_input_revision+1`)
        .run();
    if (deps.runExclusive) await deps.runExclusive(markDirty);
    else markDirty();
  }
  await app.register(memoryCurationRoutes, {
    projectRoot,
    ownerUserId,
    db,
    threadStore,
    messageStore,
    modelLabel: (catId) => catRegistry.tryGet(catId)?.config.displayName ?? catId,
  });
  deps.taskRunner.register(
    createSummaryCompactionTaskSpec({
      db,
      runExclusive: deps.runExclusive,
      enabled: () => preference().enabled,
      curation: {
        timezone: deps.householdTimeZone,
        startedAt: () => preference().startedAt,
        reconcilePendingInput: (threadId, expectedWatermark, signal) =>
          reconcileSummaryPendingInput(
            {
              db,
              runExclusive: deps.runExclusive,
              getMessagesAfterWatermark: (thread, after, limit) =>
                readCurationBatch(messageStore, ownerUserId, thread, after, limit, 0),
            },
            threadId,
            expectedWatermark,
            signal,
          ),
        shouldProcessThread: async (threadId) => {
          const thread = await threadStore.get(threadId);
          let coverage = db
            .prepare(
              'SELECT backfill_complete AS done FROM thread_curation_state WHERE owner_user_id=? AND thread_id=?',
            )
            .get(ownerUserId, threadId) as { done: number } | undefined;
          if (!coverage && thread && canAccessThread(thread, ownerUserId) && !thread.deletedAt && !thread.systemKind) {
            await backfill.initialize(threadId);
            coverage = db
              .prepare(
                'SELECT backfill_complete AS done FROM thread_curation_state WHERE owner_user_id=? AND thread_id=?',
              )
              .get(ownerUserId, threadId) as { done: number } | undefined;
          }
          return Boolean(
            thread &&
              canAccessThread(thread, ownerUserId) &&
              !thread.deletedAt &&
              !thread.systemKind &&
              coverage?.done === 1,
          );
        },
      },
      getThreadLastActivity: async (threadId) => {
        const messages = await messageStore.getByThread(threadId, 1, ownerUserId);
        return messages[0] ? { threadId, lastMessageAt: messages[0].timestamp } : null;
      },
      getMessagesAfterWatermark: (threadId, after, limit) =>
        readCurationBatch(messageStore, ownerUserId, threadId, after, limit, 0),
      generateAbstractive,
      onAttempt: recordAttempt,
      reEmbed: deps.reEmbed,
      logger: { info: app.log.info.bind(app.log), error: app.log.error.bind(app.log) },
    }),
  );
  deps.taskRunner.register({
    id: 'thread-overview-backfill',
    profile: 'awareness',
    trigger: { type: 'interval', ms: 60_000 },
    admission: {
      async gate() {
        const states = await backfill.initialize();
        return states.length
          ? { run: true as const, workItems: states.map((state) => ({ signal: state, subjectKey: state.threadId })) }
          : { run: false as const, reason: 'historical coverage complete' };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 120_000,
      async execute(state, _key, ctx) {
        await backfill.process(state, ctx.signal);
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => preference().enabled,
    display: { label: '历史线程概况补齐', category: 'thread', description: '按可续办批次补齐整本目录的历史概况' },
  });
}
