/**
 * #1838 API B of windows-job-restart-recovery.test.js: a fresh API that runs the index.ts startup
 * recovery on the durable state API A left, then reports every lifecycle object it can read.
 *
 * Modes: `baseline` is the pre-#1838 recovery (no job adoption, no job teardown proof); `fixed` is
 * the current one; `next` is `fixed` followed by the user's next turn of the same thread and role
 * passing admission and the provider-entry fence.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRedisClient } from '../../../shared/dist/utils/index.js';
import { CallbackAuthTurnExecutionLifecycle } from '../../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js';
import { createTaskProgressStore } from '../../dist/domains/cats/services/agents/invocation/createTaskProgressStore.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisAuthInvocationBackend } from '../../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import {
  lifecycleResponseIdempotencyKey,
  responseOutcomeForEndedTurn,
  settleResponseFromDraft,
} from '../../dist/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { StartupReconciler } from '../../dist/domains/cats/services/agents/invocation/StartupReconciler.js';
import { TurnExecutionStartupReconciler } from '../../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js';
import {
  clearSettledWindowsJobEvidence,
  recordVerifiedWindowsJobTeardowns,
} from '../../dist/domains/cats/services/agents/invocation/WindowsJobStopRecovery.js';
import { createDraftStore } from '../../dist/domains/cats/services/stores/factories/DraftStoreFactory.js';
import { createInvocationRecordStore } from '../../dist/domains/cats/services/stores/factories/InvocationRecordStoreFactory.js';
import { createMessageStore } from '../../dist/domains/cats/services/stores/factories/MessageStoreFactory.js';
import {
  findUnconfirmedProviderBlocker,
  hasUnconfirmedProviderTeardown,
} from '../../dist/domains/cats/services/stores/ports/TurnExecutionStore.js';
import { RedisTurnExecutionStore } from '../../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { createCliExecutionOwnerService } from '../../dist/utils/cli-process-ownership.js';
import { adoptWindowsApiJob } from '../../dist/utils/windows-job-owner.js';

const PROCESS_START_AT = Date.now();
const [configPath, mode, outFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const { execution: e, callbackToken } = JSON.parse(readFileSync(config.hostAFile, 'utf8'));
const fixed = mode !== 'baseline';
const adoption = fixed ? await adoptWindowsApiJob({ dataDir: config.dataDir }) : null;
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

// The index.ts startup order: auth, owner snapshot, job teardown proof, both reconcilers, cleanup.
await store.reconcileStartup({ processStartedAt: PROCESS_START_AT });
const live = await createCliExecutionOwnerService({ dataDir: config.dataDir }).listLive();
const pass = fixed
  ? await recordVerifiedWindowsJobTeardowns({
      store,
      dataDir: config.dataDir,
      ...(adoption.adopted ? { currentJobName: adoption.job.record.jobName } : {}),
    })
  : null;
const settleEndedTurnResponse = (turn) =>
  settleResponseFromDraft(
    { messageStore, draftStore, turnStore: store, invocationRecords: records },
    {
      userId: turn.userId,
      threadId: turn.threadId,
      invocationId: turn.invocationId,
      ...responseOutcomeForEndedTurn(turn),
    },
  );
const reconciled = live.complete
  ? await new TurnExecutionStartupReconciler({ store, settleEndedTurnResponse }).reconcile({
      processStartedAt: PROCESS_START_AT,
      protectedInvocationIds: live.owners.map((owner) => owner.invocationId),
    })
  : null;
const orphans = await new StartupReconciler({
  invocationRecordStore: records,
  turnExecutionStore: store,
  taskProgressStore: createTaskProgressStore(client),
  log,
  processStartAt: PROCESS_START_AT,
  messageStore,
}).reconcileOrphans();
registry.markStartupRecoveryComplete();
const cleared = pass ? await clearSettledWindowsJobEvidence({ store, pass }) : null;

const child = await store.get(e.invocationId);
const running = await store.listRunningByUser(e.userId);
const next = { invocationId: `next-${PROCESS_START_AT}`, threadId: e.threadId, catId: e.catId };
const blocker = findUnconfirmedProviderBlocker(running, next);
let nextProviderStarted = null;
if (mode === 'next' && !blocker) {
  await store.createRunning({
    invocationId: next.invocationId,
    parentInvocationId: next.invocationId,
    threadId: e.threadId,
    userId: e.userId,
    catId: e.catId,
    executionKind: 'ordinary',
    startedAt: Date.now(),
    providerLifecycleTracked: true,
  });
  nextProviderStarted = await store.markProviderStarted(next.invocationId, Date.now());
}
const response = await messageStore.getByIdempotencyKey(
  e.userId,
  e.threadId,
  lifecycleResponseIdempotencyKey(e.invocationId),
);
const parent = await records.get(e.executionId);
const auth = await registry.verify(e.invocationId, callbackToken);
writeFileSync(
  outFile,
  JSON.stringify({
    pid: process.pid,
    adopted: adoption?.adopted ?? null,
    liveComplete: live.complete,
    released: pass?.released ?? [],
    preserved: pass?.preserved ?? [],
    interrupted: reconciled?.invocationIds ?? [],
    settledResponses: reconciled?.settledResponseCount ?? 0,
    sweptParents: orphans.running,
    cleared,
    status: child?.status,
    terminalReason: child?.terminalReason ?? null,
    blocked: hasUnconfirmedProviderTeardown(child),
    blockerId: blocker?.invocationId ?? null,
    nextProviderStarted,
    runningIds: running.map((record) => record.invocationId),
    parent: { status: parent?.status, error: parent?.error ?? null },
    response: {
      status: response?.lifecycle?.status,
      reason: response?.lifecycle?.reason ?? null,
      content: response?.content,
    },
    drafts: (await draftStore.getByThread(e.userId, e.threadId)).length,
    responsePending: (await store.listResponsePending()).map((turn) => turn.invocationId),
    authOk: auth.ok,
    authReason: auth.ok ? null : auth.reason,
  }),
);
await client.quit();
