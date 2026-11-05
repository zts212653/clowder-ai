/**
 * #1838 API A of windows-job-restart-recovery.test.js. After adopting its kernel job it runs two real
 * invokeSingleCat turns of one thread and role. The first completes and leaves the persistent
 * logical/native session mapping. The second is admitted the way the router does it (parent
 * invocation, then the child's response R and streamed draft once invokeSingleCat names the child);
 * invokeSingleCat itself links it to the job and passes the provider-entry fence, and its provider
 * starts a tree whose PPID chain breaks. It stays inside that provider until the test kills it.
 */
import './setup-cat-registry.js';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRedisClient } from '../../../shared/dist/utils/index.js';
import { CallbackAuthTurnExecutionLifecycle } from '../../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisAuthInvocationBackend } from '../../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import { createInvocationRecordStore } from '../../dist/domains/cats/services/stores/factories/InvocationRecordStoreFactory.js';
import { RedisTurnExecutionStore } from '../../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { adoptWindowsApiJob } from '../../dist/utils/windows-job-owner.js';
import { restartTurns } from './windows-job-restart-turn.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const fail = (error) => {
  writeFileSync(config.hostAFile, JSON.stringify({ error }));
  process.exit(3);
};

const adoption = await adoptWindowsApiJob({ dataDir: config.dataDir });
if (!adoption.adopted) fail(adoption.reason);
const redis = createRedisClient({ url: config.redisUrl, keyPrefix: config.prefix });
const { threadId, userId, catId } = config.scope;

// The index.ts composition invokeSingleCat runs with: callback auth wraps the canonical store.
const canonical = new RedisTurnExecutionStore(redis);
const registry = new InvocationRegistry({
  backend: new RedisAuthInvocationBackend(redis),
  turnExecutionStore: canonical,
});
// Test-only tap: the child's callback token goes to this test's private temp file, so B can try it.
const minted = [];
const create = registry.create.bind(registry);
registry.create = async (...args) => {
  const auth = await create(...args);
  minted.push(auth);
  return auth;
};
const turns = restartTurns({
  client: redis,
  registry,
  turnExecutionStore: new CallbackAuthTurnExecutionLifecycle(canonical, registry),
  scope: config.scope,
});

// --- turn 1 completes and leaves the logical/native session mapping ---
const first = await turns.run();
if (first.errors.length > 0 || turns.calls.length !== 1) fail(`first turn: ${first.errors.join('; ')}`);
const session = await turns.session();
if (!session.logicalId || !session.nativeId) fail(`no session mapping: ${JSON.stringify(session)}`);

// --- turn 2: the parent invocation as the router admits a turn ---
const records = createInvocationRecordStore(redis);
const parent = await records.create({
  threadId,
  userId,
  targetCats: [catId],
  intent: 'execute',
  idempotencyKey: 'issue1838-parent',
  actionLeaseCarrier: { kind: 'none' },
});
if (!(await records.update(parent.invocationId, { status: 'running', expectedStatus: 'queued' }))) {
  fail('parent not running');
}
let execution;
const killed = await turns.run({
  parentInvocationId: parent.invocationId,
  streamedBody: config.streamedBody,
  // Inside the provider, after invokeSingleCat linked the job and passed the entry fence: the
  // product's stdio shape, after adoption, so the tree lands inside the job. Then it never returns.
  inProvider: async () => {
    spawn(process.execPath, [config.launcher], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    while (!existsSync(config.treeFile)) await new Promise((resolve) => setTimeout(resolve, 100));
    const tree = JSON.parse(readFileSync(config.treeFile, 'utf8'));
    const auth = minted.find((entry) => entry.invocationId === execution.invocationId);
    writeFileSync(
      config.hostAFile,
      JSON.stringify({
        host: process.pid,
        ...tree,
        jobName: adoption.job.record.jobName,
        execution,
        callbackToken: auth?.callbackToken,
        session,
        resumed: turns.calls[1].resume,
      }),
    );
    await new Promise(() => {});
  },
  onTurn: async (admitted) => {
    const { responseMessageId, startedAt, ...identity } = admitted;
    execution = { executionId: parent.invocationId, ...identity, threadId, catId, userId };
  },
});
fail(`the killed turn ended by itself: ${killed.errors.join('; ')}`);
