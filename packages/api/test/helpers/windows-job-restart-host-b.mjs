/** Fresh API B runs the shared index startup recovery and optionally the real next turn.
 * Physical teardown evidence and actual next-turn admission are separate observations. */
import './setup-cat-registry.js';
import { readFileSync, writeFileSync } from 'node:fs';
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
import { hasUnconfirmedProviderTeardown } from '../../dist/domains/cats/services/stores/ports/TurnExecutionStore.js';
import { RedisTurnExecutionStore } from '../../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { createCliExecutionOwnerService } from '../../dist/utils/cli-process-ownership.js';
import { restartTurns } from './windows-job-restart-turn.mjs';

const PROCESS_START_AT = Date.now();
const [configPath, mode, outFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { execution: e, callbackToken } = JSON.parse(readFileSync(config.hostAFile, 'utf8'));
// `settle-fail` is the fixed recovery whose response settlement throws, as a Redis error would.
// The API's one data root, as in production: recovery and the real provider entry read the same
// host-job evidence there.
process.env.CAT_CAFE_DATA_DIR = config.dataDir;
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

// The same startup recovery composition index.ts uses; both scenarios read their own data root.
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
  windowsJobDataDir: config.dataDir,
  orphans: { invocationRecordStore: records, taskProgressStore: createTaskProgressStore(client), log, messageStore },
  markStartupRecoveryComplete: () => registry.markStartupRecoveryComplete(),
});
const { childRecovery: reconciled, startupRecovery: orphans, windowsJobTeardowns: pass } = recovery;

const child = await store.get(e.invocationId);
const running = await store.listRunningByUser(e.userId);
const response = await messageStore.getByIdempotencyKey(
  e.userId,
  e.threadId,
  lifecycleResponseIdempotencyKey(e.invocationId),
);
const parent = await records.get(e.executionId);
// Read the original lifecycle, then verify its callback again after any next-turn admission.
const auth = await registry.verify(e.invocationId, callbackToken);
const drafts = (await draftStore.getByThread(e.userId, e.threadId)).length;
const responsePending = (await store.listResponsePending()).map((turn) => turn.invocationId);
// The user's next message of the same thread and role, through the product's invokeSingleCat.
let nextTurn = null;
if (mode === 'next' || mode === 'next-while-alive') {
  const turns = restartTurns({
    client,
    registry,
    turnExecutionStore: store,
    scope: config.scope,
  });
  const { errors } = await turns.run();
  nextTurn = { errors, providerCalls: turns.calls, session: await turns.session() };
}
const authAfterNext = await registry.verify(e.invocationId, callbackToken);
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
    teardownUnconfirmed: hasUnconfirmedProviderTeardown(child),
    teardownAt: child?.providerTeardownAt ?? null,
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
    authAfterNextOk: authAfterNext.ok,
    authOk: auth.ok,
    authReason: auth.ok ? null : auth.reason,
  }),
);
await client.quit();
