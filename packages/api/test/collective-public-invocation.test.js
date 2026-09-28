import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';

const forbidden = () => {
  throw new Error('PRIVATE_CONTEXT_CONSUMER_WAS_CALLED');
};
const source = {
  serviceInstanceId: 'svc_100000000000',
  collectiveId: 'col_100000000000',
  connectionId: 'con_100000000000',
  eventId: 'evt_100000000000',
  location: { channelId: 'A' },
  catId: 'codex-sol',
  participationRevision: 1,
  actor: { kind: 'human', humanId: 'human_guest00000', displayName: 'Guest' },
};
const event = {
  ...source,
  clientEventId: 'A',
  body: 'PUBLIC_A: please read and respond',
  sequence: 1,
  acceptedAt: new Date().toISOString(),
  recipient: {
    kind: 'agent',
    connectionId: source.connectionId,
    humanId: 'human_owner00000',
    agentId: 'codex-sol',
    participationRevision: 1,
  },
  target: { kind: 'agent', humanId: 'human_owner00000', agentId: 'codex-sol' },
};
const binding = {
  source,
  sourceRef: 'message:source-A',
  displayName: 'Sol',
  grant: { kind: 'collective-participation', originTriggerMessageId: 'source-A', source },
  context: {
    source: event,
    events: [event, { ...event, location: { channelId: 'B' }, body: 'PRIVATE_CHANNEL_B_CANARY' }],
  },
};

test('the real invokeSingleCat lane bypasses every private prompt/session/recall/retry input and exposes only A', async (t) => {
  const audit = await mkdtemp(join(tmpdir(), 'collective-public-invocation-audit-'));
  const old = process.env.AUDIT_LOG_DIR;
  process.env.AUDIT_LOG_DIR = audit;
  t.after(async () => {
    if (old === undefined) delete process.env.AUDIT_LOG_DIR;
    else process.env.AUDIT_LOG_DIR = old;
    await rm(audit, { recursive: true, force: true });
  });
  const registry = new InvocationRegistry();
  const executions = new InMemoryTurnExecutionStore();
  const exposed = [];
  let captured;
  const service = {
    supportsToolExecutionPolicy: (policy) => policy.mode === 'collective_participation',
    async *invoke(prompt, options) {
      captured = { prompt, options };
      const verified = await registry.verify(
        options.callbackEnv.CAT_CAFE_INVOCATION_ID,
        options.callbackEnv.CAT_CAFE_CALLBACK_TOKEN,
      );
      assert.equal(verified.record.ownerAuthProvenance, 'unknown');
      assert.deepEqual(verified.record.executionGrant, binding.grant);
      assert.equal((await executions.get(verified.record.invocationId)).status, 'running');
      yield { type: 'text', catId: 'codex-sol', content: 'Public answer', timestamp: Date.now() };
      yield { type: 'done', catId: 'codex-sol', timestamp: Date.now() };
    },
  };
  const deps = {
    registry,
    turnExecutionStore: executions,
    apiUrl: 'http://127.0.0.1:3182',
    sessionManager: {
      get: forbidden,
      getOrCreate: forbidden,
      resolveWorkingDirectory: forbidden,
      store: forbidden,
      delete: forbidden,
    },
    threadStore: { get: forbidden },
    messageStore: { getById: async () => ({ source: { connector: 'collective' } }) },
    collectiveContext: () => ({ resolvePublic: async () => binding }),
    memoryCuePromptService: { resolve: forbidden },
    freshnessStateStore: { get: forbidden },
  };
  const messages = [];
  for await (const message of invokeSingleCat(deps, {
    catId: 'codex-sol',
    service,
    userId: 'owner',
    threadId: 'public',
    isLastCat: true,
    ownerAuthProvenance: 'unknown',
    executionScope: 'collective-participation',
    a2aTriggerMessageId: 'source-A',
    prompt: 'PRIVATE_HISTORY_CANARY and PRIVATE_REPLY_PREVIEW_CANARY',
    systemPrompt: 'PRIVATE_PROFILE_CANARY',
    promptMessageIds: ['source-A', 'PRIVATE_B_MESSAGE_ID'],
    contextPromptFactory: forbidden,
    rebuildPromptAfterSessionSeal: forbidden,
    contextAssembly: { summary: 'PRIVATE_SUMMARY_CANARY' },
    sessionId: 'PRIVATE_SESSION_CANARY',
    onPromptMessagesExposed: async (input) => {
      exposed.push(...input.messageIds);
    },
  }))
    messages.push(message);
  assert.ok(captured, JSON.stringify(messages));
  assert.match(captured.prompt, /PUBLIC_A/);
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_/);
  assert.match(captured.options.systemPrompt, /cat_cafe_collective_current_context/);
  assert.match(
    captured.options.systemPrompt,
    new RegExp(catRegistry.tryGet('codex-sol').config.defaultModel.replaceAll('.', '\\.')),
  );
  assert.equal(captured.options.sessionId, undefined);
  assert.equal(captured.options.callbackEnv.CAT_CAFE_MCP_PROFILE, 'collective-participation');
  assert.deepEqual(exposed, ['source-A']);
  const invocationId = messages[0].turnInvocationId;
  assert.equal((await executions.get(invocationId)).status, 'succeeded');
});

test('a persisted public scope cannot become a private invocation when its source disappears', async () => {
  let invoked = false;
  const run = invokeSingleCat(
    { messageStore: { getById: async () => null } },
    {
      catId: 'codex-sol',
      userId: 'owner',
      threadId: 'public',
      executionScope: 'collective-participation',
      a2aTriggerMessageId: 'lost',
      service: {
        async *invoke() {
          invoked = true;
        },
      },
    },
  );
  await assert.rejects(async () => {
    for await (const _ of run) {
    }
  }, /collective_source_unavailable/);
  assert.equal(invoked, false);
});
