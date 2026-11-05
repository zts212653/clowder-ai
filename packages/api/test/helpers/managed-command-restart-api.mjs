// An isolated HTTP API process using the production hold, job, admission and receiver paths.
// Only the model provider is controlled. All state that crosses a restart is SQLite or Redis.
import './setup-cat-registry.js';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createSqliteHoldQuotaStore } from '../../dist/domains/ball-custody/hold-quota-store.js';
import { ManagedCommandWakeRecoverySweep } from '../../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { createManagedCommandWakeAdmission } from '../../dist/domains/ball-custody/managed-command-wake-admission.js';
import { createManagedCommandWakeCarrierAdapter } from '../../dist/domains/ball-custody/managed-command-wake-carrier-adapter.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { RedisQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { AgentRegistry } from '../../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { RedisInvocationRecordStore } from '../../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js';
import { RedisMessageStore } from '../../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisThreadStore } from '../../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { RedisTurnExecutionStore } from '../../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { ManagedJobService } from '../../dist/domains/managed-job/ManagedJobService.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { reminderTemplate } from '../../dist/infrastructure/scheduler/templates/reminder.js';
import { registerCallbackAuthHook } from '../../dist/routes/callback-auth-prehandler.js';
import {
  isManagedWakeRunnerActive,
  registerCallbackHoldBallRoutes,
} from '../../dist/routes/callback-hold-ball-routes.js';
import { assertRedisIsolationOrThrow } from './redis-test-helpers.js';

assertRedisIsolationOrThrow(process.env.REDIS_URL, 'managed command restart API');
const root = process.env.CAT_CAFE_DATA_DIR;
const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: process.env.REDIS_KEY_PREFIX });
const db = new Database(join(root, 'scheduler.sqlite'));
applyMigrations(db);
const tasks = new DynamicTaskStore(db);
const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
const threads = new RedisThreadStore(redis, { ttlSeconds: 0 });
const threadFile = join(root, 'thread-id');
const threadId = existsSync(threadFile)
  ? readFileSync(threadFile, 'utf8')
  : (await threads.create('restart-owner', 'managed restart regression')).id;
writeFileSync(threadFile, threadId);
const registry = new InvocationRegistry();
const tracker = new InvocationTracker();
const records = new RedisInvocationRecordStore(redis);
const turns = new RedisTurnExecutionStore(redis);
const agents = new AgentRegistry();
agents.register('opus', {
  async *invoke(prompt, options) {
    appendFileSync(
      join(root, 'provider-inputs.jsonl'),
      `${JSON.stringify({ prompt, invocationId: options.invocationId })}\n`,
    );
    yield { type: 'done', catId: 'opus', invocationId: options.invocationId, timestamp: Date.now() };
  },
});
const router = new AgentRouter({
  agentRegistry: agents,
  registry,
  messageStore: messages,
  threadStore: threads,
  turnExecutionStore: turns,
});
const queue = new InvocationQueue(new RedisQueueLedgerStore(redis), {
  resolveTargets: (targets, thread, content, exact) => router.resolveSendTargets(targets, thread, content, exact),
});
await queue.hydrateFromLedger(messages);
const socketManager = { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} };
const processor = new QueueProcessor({
  queue,
  router,
  invocationTracker: tracker,
  messageStore: messages,
  invocationRecordStore: records,
  turnExecutionStore: turns,
  socketManager,
  log: { info() {}, warn() {}, error: (...args) => console.error(...args) },
});
const admitWake = createManagedCommandWakeAdmission({ queue, messageStore: messages, notifyAdmitted: async () => {} });
const sweep = new ManagedCommandWakeRecoverySweep({
  dynamicTaskStore: tasks,
  messageStore: messages,
  invocationRecordStore: records,
  taskRunner: { unregister() {} },
  socketManager,
  admitWake,
  isCommandRunnerActive: isManagedWakeRunnerActive,
  ...createManagedCommandWakeCarrierAdapter({
    messageStore: messages,
    invocationRecordStore: records,
    invocationQueue: queue,
  }),
});
const quota = createSqliteHoldQuotaStore(join(root, 'quota.sqlite'));
const app = Fastify();
registerCallbackAuthHook(app, registry);
registerCallbackHoldBallRoutes(app, {
  registry,
  dynamicTaskStore: tasks,
  messageStore: messages,
  threadStore: threads,
  ownerUserId: 'restart-owner',
  holdQuotaStore: quota,
  invocationRecordStore: records,
  managedCommandWakeRecovery: sweep,
  admitManagedWake: admitWake,
  taskRunner: { registerDynamic() {}, unregister() {} },
  templateRegistry: { get: () => reminderTemplate },
  socketManager,
});
app.get('/fixture/auth', () =>
  registry.create('restart-owner', 'opus', threadId, undefined, undefined, undefined, undefined, 'strict'),
);
app.get('/fixture/state', async () => ({
  threadId,
  tasks: tasks.getAll(),
  jobs: new ManagedJobService().list().map((job) => new ManagedJobService().get(job.definition.principal, job.jobId)),
  messages: await messages.getByThreadIncludingQueued(threadId, 100, 'restart-owner'),
  lostReceipts: (
    await Promise.all(
      tasks
        .getAll()
        .map((task) => messages.getByIdempotencyKey('restart-owner', threadId, `hold-ball-lost:${task.id}`)),
    )
  ).filter(Boolean),
  queue: queue.list(threadId, 'restart-owner'),
}));
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await sweep.runOnce();
    await processor.processNext(threadId, 'restart-owner');
  } finally {
    ticking = false;
  }
}
await tick();
const address = await app.listen({ host: '127.0.0.1', port: 0 });
process.stdout.write(`RESTART_API_READY:${JSON.stringify({ address, threadId, pid: process.pid })}\n`);
const timer = setInterval(
  () =>
    void tick().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    }),
  100,
);
process.once('SIGTERM', async () => {
  clearInterval(timer);
  await app.close();
  while (ticking) await new Promise((resolve) => setTimeout(resolve, 10));
  await quota.close();
  db.close();
  await redis.quit();
  process.exit();
});
