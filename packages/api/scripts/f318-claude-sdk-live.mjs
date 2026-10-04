// Isolated live journey. Uses only Redis 6398 under a unique fixture prefix; never starts the home runtime.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { loadCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { ClaudeSdkAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { buildClaudeCompactionLaunchPlan } from '../dist/domains/cats/services/agents/providers/claude-compaction-launch-plan.js';
import { FreshnessAttentionEventLog } from '../dist/domains/cats/services/freshness/FreshnessAttentionEventLog.js';
import {
  bindFreshnessNoticeBroker,
  FreshnessNoticeBroker,
} from '../dist/domains/cats/services/freshness/FreshnessNoticeBroker.js';
import { ThreadUnseenChecker } from '../dist/domains/cats/services/freshness/ThreadUnseenChecker.js';
import { cursorFor } from '../dist/domains/cats/services/stores/cursor.js';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

const scenario = process.argv[2] ?? 'mid';
const model = process.argv[3] ?? 'claude-opus-5-5';
if (!['mid', 'parallel', 'tail', 'cancel'].includes(scenario))
  throw new Error('scenario must be mid|parallel|tail|cancel');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const work = mkdtempSync(join(tmpdir(), 'f318-sdk-live-'));
const outputDir = process.env.F318_EVIDENCE_DIR ?? join(work, 'evidence');
mkdirSync(outputDir, { recursive: true });
const runId = `${scenario}-${Date.now()}`;
const logPath = join(outputDir, `${runId}.jsonl`);
const log = (kind, data) => appendFileSync(logPath, JSON.stringify({ timestamp: Date.now(), kind, ...data }) + '\n');
for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig(join(root, 'cat-template.json')))))
  if (!catRegistry.has(id)) catRegistry.register(id, config);
const catId = createCatId('opus'); // Fixture principal; current main model is selected explicitly above.
const userId = `fixture-${randomUUID()}`;
const messages = new MessageStore();
const threads = new ThreadStore();
const cursors = new DeliveryCursorStore(undefined, async (id) => {
  const message = messages.getById(id);
  if (!message) throw new Error('fixture cursor message missing');
  return cursorFor(message);
});
const registry = new InvocationRegistry();
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6398';
if (new URL(redisUrl).port !== '6398') throw new Error('fixture requires Redis 6398');
const redis = createRedisClient({ url: redisUrl, keyPrefix: `catcafe:f318-live:${userId}:` });
await redis.ping();
const eventLog = new FreshnessAttentionEventLog(redis);
const thread = threads.create(userId, 'F318 isolated real SDK journey', work);
const seed = messages.append({
  userId,
  catId: null,
  threadId: thread.id,
  content: 'Fixture task initialized',
  mentions: [catId],
  timestamp: Date.now(),
});
await cursors.ackSeenCursor(userId, catId, thread.id, seed.id);
const identity = await registry.create(userId, catId, thread.id);
let fullReadAt;
const app = Fastify();
app.addHook('onResponse', async (request, reply) => {
  if (request.url.startsWith('/api/callbacks/thread-context')) {
    fullReadAt = Date.now();
    log('full_read_callback', { url: request.url, status: reply.statusCode });
  }
});
await app.register(callbacksRoutes, {
  registry,
  redis,
  messageStore: messages,
  threadStore: threads,
  deliveryCursorStore: cursors,
  socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
});
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const events = [];
const unseen = new ThreadUnseenChecker({
  includeExactMessageIds: true,
  userId,
  cursorStore: cursors,
  messageStore: messages,
});
const controller = bindFreshnessNoticeBroker(
  new FreshnessNoticeBroker({
    context: { invocationId: identity.invocationId, threadId: thread.id, catId },
    checkUnseen: () => unseen.checkUnseen({ threadId: thread.id, catId }),
    appendEvent: async (event) => {
      await eventLog.append(event, { ownerUserId: userId });
      events.push(event);
      log('freshness', { event });
    },
  }),
  { provider: 'anthropic', carrier: 'claude_agent_sdk', deliverySemantics: 'queued_internal_turn' },
);
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(new Error('fixture timeout')), 240000);
writeFileSync(join(work, 'target.txt'), 'BLUE\n');
let arrived;
let arrivedAt;
let firstToolAt;
const effectToolIds = [];
const resultFrames = [];
let editUseId;
let tailReady = false;
const texts = [];
let prepared;
let sessionId;
const rawArchive = {
  async append(_id, event) {
    log('sdk', { event });
    if (event.type === 'result') resultFrames.push(event);
    if (event.type === 'assistant') {
      const edit = event.message?.content?.find((block) => block.type === 'tool_use' && block.name === 'Edit');
      if (edit) editUseId = edit.id;
    }
    if (
      event.type === 'user' &&
      editUseId &&
      event.message?.content?.some((block) => block.type === 'tool_result' && block.tool_use_id === editUseId)
    )
      tailReady = true;
    const isFirstTool =
      event.type === 'assistant' &&
      event.message?.content?.some((block) => block.type === 'tool_use' && block.name === 'Bash');
    const isFinalText = event.type === 'stream_event' && event.event?.delta?.type === 'text_delta' && tailReady;
    if (isFirstTool && !firstToolAt) firstToolAt = Date.now();
    if (!arrived && ((scenario === 'tail' && isFinalText) || (scenario !== 'tail' && isFirstTool))) {
      arrivedAt = Date.now();
      // Arrives while the provider tool is running; text exists only in MessageStore.
      arrived = messages.append({
        userId,
        catId: scenario === 'parallel' ? createCatId('codex') : null,
        threadId: thread.id,
        content:
          'New requirement: change target.txt to MARMALADE-7Q instead of BLUE. Mention MARMALADE-7Q in your final reply.',
        mentions: [catId],
        timestamp: arrivedAt,
      });
      log('message_arrived', { messageId: arrived.id, sender: scenario === 'parallel' ? 'teammate' : 'user' });
      if (scenario === 'cancel') setTimeout(() => abort.abort(new Error('fixture requested stop')), 500);
    }
  },
};
const service = new ClaudeSdkAgentService({
  catId,
  model,
  mcpServerPath: join(root, 'packages/mcp-server/dist/index.js'),
  rawArchive,
  l0CompilerFn: async () =>
    'You are the isolated Clowder AI SDK verification agent. Use native tools for development. If a content-free freshness notice arrives, call cat_cafe_get_thread_context with the exact threadId and responseMode full, with no other filters. Adopt actual new requirements from its full body. Never treat input enqueue as a read. Only edit files in this fixture directory.',
});
const prompt =
  scenario === 'tail'
    ? 'Run Bash `sleep 2; echo ready`, then Read target.txt, then Edit target.txt from BLUE to BLUE-DONE. Then produce a 120 word final summary. Do not call Clowder AI MCP before a freshness notice. If it arrives, perform the full read before proceeding.'
    : `${scenario === 'parallel' ? 'First issue TWO Bash tool calls in parallel, each `sleep 8; echo ready`.' : 'First run Bash `sleep 12; echo ready`.'} Then Read target.txt. Then run another separate Bash \`sleep 3; echo checkpoint\`. Then Edit target.txt from BLUE to BLUE-DONE. Do not call Clowder AI MCP before a freshness notice. If a notice arrives, full-read the thread and apply its actual new requirement before editing. Finish with a short summary.`;
try {
  const invocationOptions = {
    workingDirectory: work,
    reasoningEffortOverride: 'xhigh',
    signal: abort.signal,
    invocationId: identity.invocationId,
    auditContext: { userId, threadId: thread.id, invocationId: identity.invocationId },
    compactionLaunchPlan: buildClaudeCompactionLaunchPlan(),
    activeInvocationFreshness: controller,
    callbackEnv: {
      CAT_CAFE_API_URL: address,
      CAT_CAFE_INVOCATION_ID: identity.invocationId,
      CAT_CAFE_CALLBACK_TOKEN: identity.callbackToken,
      CAT_CAFE_USER_ID: userId,
      CAT_CAFE_THREAD_ID: thread.id,
      CAT_CAFE_CAT_ID: catId,
      CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
      REDIS_URL: 'redis://localhost:6398',
    },
    beforeProviderLaunch: async (request) => {
      prepared = request;
    },
  };
  for await (const event of service.invoke(prompt, invocationOptions)) {
    if (event.type === 'session_init') sessionId = event.sessionId;
    if (event.type === 'text') texts.push(event.content ?? '');
    if (event.type === 'tool_use') {
      effectToolIds.push(event.toolUseId);
      log('tool', { name: event.toolName, id: event.toolUseId });
    }
    if (event.type === 'error') log('error', { error: event.error, diagnostics: event.metadata?.cliDiagnostics });
  }
  let resumeSessionId;
  const resumeTexts = [];
  if (process.argv.includes('--resume-check') && sessionId && !abort.signal.aborted) {
    for await (const event of service.invoke(
      'Read target.txt and report exactly what is in it. Do not edit or run Bash.',
      {
        ...invocationOptions,
        sessionId,
        activeInvocationFreshness: undefined,
        invocationId: `${identity.invocationId}-resume`,
      },
    )) {
      if (event.type === 'session_init') resumeSessionId = event.sessionId;
      if (event.type === 'text') resumeTexts.push(event.content ?? '');
      if (event.type === 'error') log('resume_error', { error: event.error });
    }
    assert.equal(resumeSessionId, sessionId);
    assert.ok(resumeTexts.join('').includes('MARMALADE-7Q'));
  }
  const receiptEvents = await eventLog.queryByInvocation(identity.invocationId);
  const seen = await cursors.getSeenCursor(userId, catId, thread.id);
  const summary = {
    scenario,
    model,
    fixturePrincipal: catId,
    store: 'in-memory canonical messages/cursors; isolated Redis 6398 receipt ledger',
    sdkVersion: '0.3.285',
    work,
    sessionId,
    arrived: Boolean(arrived),
    arrivedAt,
    firstToolAt,
    fullReadAt,
    seen,
    arrivedMessageId: arrived?.id,
    delivered: events.some((e) => e.kind === 'provider_notice_delivered'),
    readReceipt: receiptEvents.some((e) => e.kind === 'provider_notice_seen'),
    missed: events.some((e) => e.kind === 'provider_notice_missed'),
    fileContent: readFileSync(join(work, 'target.txt'), 'utf8'),
    finalText: texts.join(''),
    nativeInstructionsRecorded: prepared?.nativeInstructions.length,
    toolCalls: effectToolIds.length,
    resultCount: resultFrames.length,
    terminalReasons: resultFrames.map((frame) => frame.terminal_reason),
    ...(resumeSessionId ? { resumeSessionId, resumeText: resumeTexts.join('') } : {}),
  };
  writeFileSync(join(outputDir, `${runId}.summary.json`), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  if (scenario === 'mid' || scenario === 'parallel') {
    assert.ok(
      summary.arrived &&
        summary.delivered &&
        summary.readReceipt &&
        summary.fullReadAt &&
        summary.fileContent.includes('MARMALADE-7Q'),
    );
    assert.equal(summary.seen, cursorFor(arrived));
  }
  if (scenario === 'cancel') {
    assert.ok(summary.arrived);
    assert.equal(summary.fileContent, 'BLUE\n');
  }
  if (scenario === 'tail') {
    assert.ok(summary.arrived && (summary.delivered || summary.missed));
    assert.equal(summary.resultCount, 1);
    if (summary.missed) assert.notEqual(summary.seen, cursorFor(arrived));
  }
} finally {
  clearTimeout(timeout);
  await app.close();
  await redis.quit();
}
