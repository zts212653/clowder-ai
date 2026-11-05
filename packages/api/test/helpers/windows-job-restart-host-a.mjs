/**
 * #1838 API A of windows-job-restart-recovery.test.js: admits one turn the way the router and
 * invoke-single-cat do (parent invocation, callback credential, child, response R, streamed draft),
 * links it to this API's kernel job, marks the provider started, then starts a provider tree whose
 * PPID chain breaks. It stays alive until the test kills it.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRedisClient } from '../../../shared/dist/utils/index.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisAuthInvocationBackend } from '../../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js';
import { lifecycleResponseIdempotencyKey } from '../../dist/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { createDraftStore } from '../../dist/domains/cats/services/stores/factories/DraftStoreFactory.js';
import { createInvocationRecordStore } from '../../dist/domains/cats/services/stores/factories/InvocationRecordStoreFactory.js';
import { createMessageStore } from '../../dist/domains/cats/services/stores/factories/MessageStoreFactory.js';
import { RedisTurnExecutionStore } from '../../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js';
import { recordWindowsJobExecutionLink } from '../../dist/utils/windows-job-execution-links.js';
import { adoptWindowsApiJob } from '../../dist/utils/windows-job-owner.js';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const fail = (error) => {
  writeFileSync(config.hostAFile, JSON.stringify({ error }));
  process.exit(3);
};

const adoption = await adoptWindowsApiJob({ dataDir: config.dataDir });
if (!adoption.adopted) fail(adoption.reason);
const redis = createRedisClient({ url: config.redisUrl, keyPrefix: config.prefix });
const store = new RedisTurnExecutionStore(redis);
const { threadId, userId, catId } = config.scope;

// The parent invocation, then the child's callback credential, as the router admits a turn.
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
const registry = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(redis), turnExecutionStore: store });
const auth = await registry.create(userId, catId, threadId, parent.invocationId);
const execution = { executionId: parent.invocationId, invocationId: auth.invocationId, threadId, catId, userId };
const startedAt = Date.now();
const created = await store.createRunning({
  invocationId: execution.invocationId,
  parentInvocationId: execution.executionId,
  threadId,
  userId,
  catId,
  executionKind: 'ordinary',
  startedAt,
  providerLifecycleTracked: true,
});
if (created.outcome !== 'created') fail(`not created: ${created.outcome}`);

// The original response R and the body its draft streamed before the crash.
await createMessageStore(redis).append({
  from: { kind: 'agent', catId },
  userId,
  content: '',
  mentions: [],
  origin: 'stream',
  timestamp: startedAt,
  threadId,
  idempotencyKey: lifecycleResponseIdempotencyKey(execution.invocationId),
  lifecycle: {
    kind: 'response',
    orderKey: `${startedAt}:${execution.invocationId}`,
    invocationId: execution.invocationId,
    targetId: catId,
    inputEntryIds: [],
    inputMessageIds: [],
    status: 'processing',
    startedAt,
  },
});
await createDraftStore(redis).upsert({
  userId,
  threadId,
  invocationId: execution.invocationId,
  catId,
  content: config.streamedBody,
  updatedAt: Date.now(),
});

// The provider-entry order in invoke-single-cat: link to the job, then mark the provider started.
recordWindowsJobExecutionLink({ dataDir: adoption.job.dataDir, jobName: adoption.job.record.jobName, execution });
if (!(await store.markProviderStarted(execution.invocationId, Date.now()))) fail('provider entry fence rejected');

// Spawned with the product's stdio shape, after adoption, so the tree lands inside the job.
spawn(process.execPath, [config.launcher], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
while (!existsSync(config.treeFile)) await new Promise((resolve) => setTimeout(resolve, 100));
const tree = JSON.parse(readFileSync(config.treeFile, 'utf8'));
// The callback token goes only to this test's private temp file, so B can try it after recovery.
writeFileSync(
  config.hostAFile,
  JSON.stringify({
    host: process.pid,
    ...tree,
    jobName: adoption.job.record.jobName,
    execution,
    callbackToken: auth.callbackToken,
  }),
);
setInterval(() => {}, 1000);
