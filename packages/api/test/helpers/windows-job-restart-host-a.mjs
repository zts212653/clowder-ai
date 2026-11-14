/** API A runs two real turns: the first persists its session; the second hangs in real spawnCli.
 * Covered mode owns its provider Job; legacy mode never writes a link. */
import './setup-cat-registry.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRedisClient } from '../../../shared/dist/utils/index.js';
import { CallbackAuthTurnExecutionLifecycle } from '../../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisAuthInvocationBackend } from '../../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import { createInvocationRecordStore } from '../../dist/domains/cats/services/stores/factories/InvocationRecordStoreFactory.js';
import { RedisTurnExecutionStore } from '../../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { spawnCli } from '../../dist/utils/cli-spawn.js';
import { readWindowsJobNamesLinkedTo } from '../../dist/utils/windows-job-execution-links.js';
import { restartTurns } from './windows-job-restart-turn.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const fail = (error) => {
  writeFileSync(config.hostAFile, JSON.stringify({ error }));
  process.exit(3);
};

// The API itself never adopts a job: invokeSingleCat puts the covered provider in a host whose own
// job owns it, under this data root.
process.env.CAT_CAFE_DATA_DIR = config.dataDir;
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
  windowsProviderHosts: !config.legacy,
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
  // Inside the provider, after invokeSingleCat linked the turn to its host and passed the entry
  // fence: the real spawnCli seam launches the provider root in that host. The root stays, its
  // launcher exits after detaching the writer (the broken PPID chain). Then it never returns.
  inProvider: async (options) => {
    const provider = spawnCli({ command: process.execPath, args: [config.root], invocationId: options.invocationId });
    void provider[Symbol.asyncIterator]().next();
    while (!existsSync(config.treeFile)) await new Promise((resolve) => setTimeout(resolve, 100));
    const tree = JSON.parse(readFileSync(config.treeFile, 'utf8'));
    const auth = minted.find((entry) => entry.invocationId === execution.invocationId);
    const [jobName] = readWindowsJobNamesLinkedTo(execution.invocationId, config.dataDir) ?? [];
    writeFileSync(
      config.hostAFile,
      JSON.stringify({
        host: process.pid,
        ...tree,
        jobName,
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
