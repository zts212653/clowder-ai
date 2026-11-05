/**
 * #1838 API B of windows-job-restart-recovery.test.js: a fresh API that runs the index.ts startup
 * recovery on the durable state API A left, then reports every lifecycle object it can read.
 *
 * All modes run the product's `recoverPriorProcessExecutions`. `baseline` is the pre-#1838 recovery
 * (no job adoption, no job evidence); `fixed` is the current one; `settle-fail` is `fixed` with a
 * response settlement that throws. `baseline` and `next` then run the user's next turn of the same
 * thread and role through the real invokeSingleCat, which must refuse it (baseline) or reach its
 * provider resuming the session API A left (next).
 */
import './setup-cat-registry.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRedisClient } from '../../../shared/dist/utils/index.js';
import { CallbackAuthTurnExecutionLifecycle } from '../../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js';
import { createTaskProgressStore } from '../../dist/domains/cats/services/agents/invocation/createTaskProgressStore.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { recoverPriorProcessExecutions } from '../../dist/domains/cats/services/agents/invocation/prior-process-execution-recovery.js';
import { RedisAuthInvocationBackend } from '../../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import {
  lifecycleResponseIdempotencyKey,
  responseOutcomeForEndedTurn,
  settleResponseFromDraft,
} from '../../dist/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { createDraftStore } from '../../dist/domains/cats/services/stores/factories/DraftStoreFactory.js';
import { createInvocationRecordStore } from '../../dist/domains/cats/services/stores/factories/InvocationRecordStoreFactory.js';
import { createMessageStore } from '../../dist/domains/cats/services/stores/factories/MessageStoreFactory.js';
import {
  findUnconfirmedProviderBlocker,
  hasUnconfirmedProviderTeardown,
} from '../../dist/domains/cats/services/stores/ports/TurnExecutionStore.js';
import { RedisTurnExecutionStore } from '../../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { createCliExecutionOwnerService } from '../../dist/utils/cli-process-ownership.js';
import { restartTurns } from './windows-job-restart-turn.mjs';

const PROCESS_START_AT = Date.now();
const [configPath, mode, outFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { execution: e, callbackToken } = JSON.parse(readFileSync(config.hostAFile, 'utf8'));
// `settle-fail` is the fixed recovery whose response settlement throws, as a Redis error would.
const fixed = mode !== 'baseline';
// The API's one data root, as in production: recovery and the real provider entry read the same
// host-job evidence there.
if (fixed) process.env.CAT_CAFE_DATA_DIR = config.dataDir;
const client = createRedisClient({ url: config.redisUrl, keyPrefix: config.prefix });

// The index.ts composition: callback auth wraps the canonical store; recovery settles through it.
const canonical = new RedisTurnExecutionStore(client);
const registry = new InvocationRegistry({
  backend: new RedisAuthInvocationBackend(client),
  startupRecoveryRequired: true,
  turnExecutionStore: canonical,
});
const store = new CallbackAuthTurnExecutionLifecycle(canonical, registry);
const records = createInvocationRecordStore(client);
const messageStore = createMessageStore(client);
const draftStore = createDraftStore(client);
const log = { info() {}, warn: (message) => process.stderr.write(`${message}\n`) };

// The index.ts startup recovery itself. Before #1838 there was no job evidence to read at all.
const recovery = await recoverPriorProcessExecutions({
  processStartedAt: PROCESS_START_AT,
  turnExecutionStore: store,
  listLiveExecutionOwners: () => createCliExecutionOwnerService({ dataDir: config.dataDir }).listLive(),
  settleEndedTurnResponse: async (turn) => {
    if (mode === 'settle-fail') throw new Error('injected response settlement failure');
    return settleResponseFromDraft(
      { messageStore, draftStore, turnStore: store, invocationRecords: records },
      {
        userId: turn.userId,
        threadId: turn.threadId,
        invocationId: turn.invocationId,
        ...responseOutcomeForEndedTurn(turn),
      },
    );
  },
  windowsJobDataDir: fixed ? config.dataDir : join(config.dataDir, 'pre-1838-no-job-evidence'),
  orphans: { invocationRecordStore: records, taskProgressStore: createTaskProgressStore(client), log, messageStore },
  markStartupRecoveryComplete: () => registry.markStartupRecoveryComplete(),
});
const { childRecovery: reconciled, startupRecovery: orphans, windowsJobTeardowns: pass } = recovery;

const child = await store.get(e.invocationId);
const running = await store.listRunningByUser(e.userId);
const next = { invocationId: `next-${PROCESS_START_AT}`, threadId: e.threadId, catId: e.catId };
const blocker = findUnconfirmedProviderBlocker(running, next);
const response = await messageStore.getByIdempotencyKey(
  e.userId,
  e.threadId,
  lifecycleResponseIdempotencyKey(e.invocationId),
);
const parent = await records.get(e.executionId);
// Read the crashed child's own truth first: a refused next turn still mints its credential and
// retires the slot's previous one, which is not what this evidence is about.
const auth = await registry.verify(e.invocationId, callbackToken);
const drafts = (await draftStore.getByThread(e.userId, e.threadId)).length;
const responsePending = (await store.listResponsePending()).map((turn) => turn.invocationId);
// The user's next message of the same thread and role, through the product's invokeSingleCat.
let nextTurn = null;
if (mode === 'next' || mode === 'baseline') {
  const turns = restartTurns({
    client,
    registry,
    turnExecutionStore: store,
    scope: config.scope,
  });
  const { errors } = await turns.run();
  nextTurn = { errors, providerCalls: turns.calls, session: await turns.session() };
}
writeFileSync(
  outFile,
  JSON.stringify({
    pid: process.pid,
    liveComplete: recovery.liveOwnersComplete,
    released: pass.released,
    preserved: pass.preserved,
    interrupted: reconciled.invocationIds,
    settledResponses: reconciled.settledResponseCount,
    settlementFailures: reconciled.responseSettlementFailures.map((failure) => failure.invocationId),
    sweptParents: orphans.running,
    cleared: recovery.windowsJobEvidence,
    status: child?.status,
    terminalReason: child?.terminalReason ?? null,
    blocked: hasUnconfirmedProviderTeardown(child),
    blockerId: blocker?.invocationId ?? null,
    nextTurn,
    runningIds: running.map((record) => record.invocationId),
    parent: { status: parent?.status, error: parent?.error ?? null },
    response: {
      status: response?.lifecycle?.status,
      reason: response?.lifecycle?.reason ?? null,
      content: response?.content,
    },
    drafts,
    responsePending,
    authOk: auth.ok,
    authReason: auth.ok ? null : auth.reason,
  }),
);
await client.quit();
