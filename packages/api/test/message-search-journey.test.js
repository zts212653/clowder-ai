import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { handleGetThreadContext } from '../../mcp-server/dist/tools/callback-tools.js';
import { handleSearchEvidence } from '../../mcp-server/dist/tools/evidence-tools.js';
import { AgentKeyRegistry } from '../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { createConciergeMessageSearch } from '../dist/domains/concierge/concierge-message-search.js';
import { extractConciergeActions } from '../dist/domains/concierge/concierge-reply-validator.js';
import {
  buildConciergeSearchContext,
  formatConciergeHandleBinding,
} from '../dist/domains/concierge/concierge-search-context.js';
import { IndexBuilder } from '../dist/domains/memory/IndexBuilder.js';
import { MessageSearchService } from '../dist/domains/memory/MessageSearchService.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { evidenceRoutes } from '../dist/routes/evidence.js';

// The ordinary API suite does not allocate Redis. Like the other Redis journeys,
// this contract is executed explicitly through the canonical isolated runner.
const isolated = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';

async function runMessageSearchJourney() {
  assert.equal(process.env.CAT_CAFE_REDIS_TEST_ISOLATED, '1', 'use the canonical isolated Redis runner');
  const endpoint = new URL(process.env.REDIS_URL);
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.ok(![6397, 6398, 6399, 6401].includes(Number(endpoint.port)));
  const redis = createRedisClient({ url: endpoint.href });
  const messageStore = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const threadStore = new RedisThreadStore(redis, { ttlSeconds: 0 });
  const directory = mkdtempSync(join(tmpdir(), 'f322-query-journey-'));
  const evidenceStore = new SqliteEvidenceStore(join(directory, 'evidence.sqlite'));
  const registry = new InvocationRegistry(); // Explicit isolated memory auth; no durability claim.
  const agentKeyRegistry = new AgentKeyRegistry(); // Test-only in-memory keys; no live credential access.
  const app = Fastify();
  const priorEnv = { ...process.env };
  let builder;
  try {
    await redis.ping();
    await evidenceStore.initialize();
    const original = await threadStore.create('owner', '最初的琴键讨论');
    const foreground = await threadStore.create('owner', '最近的转述');
    const privateThread = await threadStore.create('other-owner', '不可读的历史');
    const threads = [original, foreground, privateThread];
    const append = (thread, content, timestamp, extra = {}) =>
      messageStore.append({
        userId: thread.createdBy,
        threadId: thread.id,
        catId: 'codex61-sol',
        mentions: [],
        content,
        timestamp,
        ...extra,
      });
    const content = '最初讨论琴键导航如何保住阅读位置。findoldpiano 是这次来源的记号。';
    const first = await append(original, content, Date.parse('2026-09-01T00:00:00Z'));
    const again = await append(original, content, Date.parse('2026-09-02T00:00:00Z'));
    const retold = await append(foreground, content, Date.parse('2026-09-03T00:00:00Z'));
    const question = await append(foreground, content, Date.parse('2026-10-01T00:00:00Z'), {
      catId: null,
      deliveryStatus: 'queued',
    });
    await append(privateThread, content, Date.parse('2026-08-01T00:00:00Z'));
    builder = new IndexBuilder(
      evidenceStore,
      directory,
      undefined,
      undefined,
      () => threads,
      (id, limit) => messageStore.getByThread(id, limit, threads.find((thread) => thread.id === id).createdBy),
    );
    for (const thread of threads) builder.markThreadDirty(thread.id);
    await builder.flushDirtyThreads();
    const service = new MessageSearchService({ evidenceStore, messageStore, threadStore });
    await app.register(evidenceRoutes, { evidenceStore, messageSearchService: service });
    await app.register(callbacksRoutes, {
      registry,
      agentKeyRegistry,
      messageStore,
      threadStore,
      evidenceStore,
      socketManager: { broadcastAgentMessage() {} },
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    assert.ok(![3001, 3002, 3011, 3012, 4111].includes(Number(new URL(address).port)));
    const auth = await registry.create(
      'owner',
      'codex61-sol',
      foreground.id,
      undefined,
      undefined,
      undefined,
      question.id,
      'strict',
    );
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
    delete process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
    process.env.CAT_CAFE_API_URL = address;
    process.env.CAT_CAFE_INVOCATION_ID = auth.invocationId;
    process.env.CAT_CAFE_CALLBACK_TOKEN = auth.callbackToken;
    process.env.CAT_CAFE_USER_ID = 'forged-environment-user';
    const ids = [first.id, again.id, retold.id];
    const query = 'findoldpiano';
    const catResult = await handleSearchEvidence({ query, resultUnit: 'message', mode: 'hybrid' });
    assert.equal(catResult.isError, undefined, catResult.content[0].text);
    const cat = JSON.parse(catResult.content[0].text);
    assert.deepEqual(
      cat.results.map((hit) => hit.messageId),
      ids,
    );
    assert.equal(cat.meta.scope, 'global');
    assert.equal(cat.meta.effectiveMode, 'lexical');
    assert.equal(cat.meta.freshness, 'unknown');
    const humanResponse = await fetch(`${address}/api/evidence/search?q=${query}&resultUnit=message`, {
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(humanResponse.status, 200);
    const human = await humanResponse.json();
    assert.deepEqual(human.results, cat.results, 'same readable candidates for the shared query contract');
    const current = JSON.parse(
      (
        await handleSearchEvidence({
          query,
          resultUnit: 'message',
          threadId: foreground.id,
          mode: 'lexical',
        })
      ).content[0].text,
    );
    assert.deepEqual(
      current.results.map((hit) => hit.messageId),
      [retold.id],
    );
    const originalRead = await handleGetThreadContext({
      threadId: first.threadId,
      messageId: first.id,
      before: 0,
      after: 0,
      responseMode: 'full',
    });
    assert.equal(originalRead.isError, undefined, originalRead.content[0].text);
    const envelope = JSON.parse(originalRead.content[0].text);
    assert.equal(envelope.messages.find((message) => message.id === first.id)?.content, content);
    const concierge = await buildConciergeSearchContext({
      userMessage: query,
      threadId: foreground.id,
      messageSearch: createConciergeMessageSearch({
        evidenceStore,
        messageStore,
        threadStore,
        userId: 'owner',
        source: { threadId: foreground.id, messageId: question.id },
      }),
    });
    assert.deepEqual(
      concierge.handles.map((handle) => handle.anchor.messageId),
      ids,
    );
    assert.deepEqual(concierge.messageSearch.results, cat.results);
    const marker = formatConciergeHandleBinding(concierge.handles[0].label, concierge.handles[0].anchor);
    const actions = extractConciergeActions(`[跳过去 ${marker}]`, concierge.handles);
    assert.equal(actions.length, 1, 'the real query projection reaches the existing navigation action consumer');
    assert.equal(actions[0].payload.threadId, first.threadId);
    assert.equal(actions[0].payload.messageId, first.id);
    const denied = await fetch(`${address}/api/callbacks/search-evidence?q=${query}&resultUnit=message`, {
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': 'wrong-token' },
    });
    assert.equal(denied.status, 401);
    console.log(
      JSON.stringify({
        source: 'controlled persisted Redis + real IndexBuilder/SQLite + compiled HTTP/MCP/reader',
        query,
        globalHits: cat.results.length,
        currentHits: current.results.length,
        exactOriginalRead: true,
        sourceExcluded: !cat.results.some((hit) => hit.messageId === question.id),
        privateThreadExcluded: !cat.results.some((hit) => hit.threadId === privateThread.id),
        providerLatency: 'unknown; no provider invoked',
        liveUserHistory: false,
      }),
    );
    const chinese = JSON.parse(
      (
        await handleSearchEvidence({
          query: '琴键',
          resultUnit: 'message',
          mode: 'lexical',
        })
      ).content[0].text,
    );
    assert.deepEqual(
      chinese.results.map((hit) => hit.messageId),
      ids,
      'Chinese substring in natural original text',
    );
    const key = await agentKeyRegistry.issue('codex61-sol', 'owner');
    delete process.env.CAT_CAFE_INVOCATION_ID;
    delete process.env.CAT_CAFE_CALLBACK_TOKEN;
    delete process.env.CAT_CAFE_AGENT_KEY_BOUND_CAT_ID;
    delete process.env.CAT_CAFE_AGENT_KEY_FILES;
    delete process.env.CAT_CAFE_AGENT_KEY_FILE;
    process.env.CAT_CAFE_AGENT_KEY_SECRET = key.secret;
    const agentResult = await handleSearchEvidence({ query, resultUnit: 'message', mode: 'lexical' });
    assert.equal(agentResult.isError, undefined, agentResult.content[0].text);
    const agent = JSON.parse(agentResult.content[0].text);
    assert.deepEqual(
      agent.results.map((hit) => hit.messageId),
      ids,
      'verified persistent cat gets only its owner-readable canonical messages',
    );
    assert.equal(agent.meta.excludeSource, undefined, 'persistent agent has no authenticated invocation question');
    const agentOriginalRead = await handleGetThreadContext({
      threadId: first.threadId,
      messageId: first.id,
      before: 0,
      after: 0,
      responseMode: 'full',
    });
    assert.equal(agentOriginalRead.isError, undefined, agentOriginalRead.content[0].text);
    assert.equal(
      JSON.parse(agentOriginalRead.content[0].text).messages.find((message) => message.id === first.id)?.content,
      content,
    );
    const crossOwner = await fetch(
      `${address}/api/callbacks/search-evidence?q=${query}&resultUnit=message&threadId=${privateThread.id}&userId=other-owner`,
      { headers: { 'x-agent-key-secret': key.secret } },
    );
    assert.equal(crossOwner.status, 403);
    await agentKeyRegistry.revoke(key.agentKeyId, 'isolated fixture cleanup');
    const revoked = await handleSearchEvidence({ query, resultUnit: 'message' });
    assert.equal(revoked.isError, true, 'revoked persistent key cannot query');
  } finally {
    await app.close();
    evidenceStore.close();
    await redis.quit();
    rmSync(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
    Object.assign(process.env, priorEnv);
  }
}

test(
  'real isolated index → HTTP/MCP message query → original reader and concierge projection',
  { skip: isolated ? false : 'Redis isolation not configured; run through the canonical isolated Redis runner' },
  runMessageSearchJourney,
);
