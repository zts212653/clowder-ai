import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { readCurationPreference, saveCurationPreference } from '../../src/config/user-preferences-curation.js';
import { AgentRegistry } from '../../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { parseCursor } from '../../src/domains/cats/services/stores/cursor.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import type { AgentService } from '../../src/domains/cats/services/types.js';
import { readCurationBatch, readCurationMessages } from '../../src/domains/memory/CurationMessageReader.js';
import { ThreadOverviewRepository } from '../../src/domains/memory/curation/ThreadOverviewRepository.js';
import { SqliteEvidenceStore } from '../../src/domains/memory/SqliteEvidenceStore.js';
import type { createSummaryCompactionTaskSpec } from '../../src/domains/memory/SummaryCompactionTaskSpec.js';
import { registerLunaCuration } from '../../src/luna-curation-setup.js';
import { memoryCurationRoutes } from '../../src/routes/memory-curation.js';

test('reader skips 300 historical bodies without spending the 200-message input window', async () => {
  const messages = new MessageStore();
  const append = (content: string, timestamp: number) =>
    messages.append({ threadId: 'home', userId: 'owner', catId: null, mentions: [], content, timestamp });
  for (let i = 1; i <= 300; i++) append('HISTORICAL_SECRET', i);
  const fresh = append('NEW_TAIL', 1001);
  assert.deepEqual(
    (await readCurationMessages(messages, 'owner', 'home', null, 200, 1000)).map((message) => message.id),
    [fresh.id],
  );
});

test('a missing watermark never rescans already processed post-enable history', async () => {
  const messages = new MessageStore();
  messages.append({
    threadId: 'home',
    userId: 'owner',
    catId: null,
    mentions: [],
    content: 'ALREADY_PROCESSED',
    timestamp: 1001,
  });
  assert.deepEqual(await readCurationMessages(messages, 'owner', 'home', 'gone-watermark', 200, 1000), []);
});

test('live reader returns a bounded accounting page and the next page reaches owner material', async () => {
  const messages = new MessageStore();
  for (let i = 0; i < 201; i++)
    messages.append({ threadId: 'home', userId: 'scheduler', catId: null, content: 'system log', timestamp: i });
  const fresh = messages.append({
    threadId: 'home',
    userId: 'owner',
    catId: null,
    content: 'new idea',
    timestamp: 202,
  });
  const first = await readCurationBatch(messages, 'owner', 'home', null, 200, 0);
  assert.equal(first.scannedMessages.length, 200);
  assert.deepEqual(first.messages, []);
  const next = await readCurationBatch(messages, 'owner', 'home', first.scannedMessages.at(-1)!.id, 200, 0);
  assert.deepEqual(
    next.messages.map((m) => m.id),
    [fresh.id],
  );
});

test('off remains inert; enabled native helper persists sources, FTS recall, owner UI and a single actual-token run line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f321-luna-integration-'));
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const db = evidence.getDb();
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create('owner', '这次共创');
  const registry = new AgentRegistry();
  let calls = 0;
  const prompts: string[] = [];
  const service: AgentService = {
    supportsToolExecutionPolicy: () => true,
    async *invoke(prompt) {
      calls++;
      prompts.push(prompt);
      const id = prompt.match(/\[message ([^\]]+)\]/)![1];
      yield {
        type: 'text',
        catId: 'codex6-luna',
        timestamp: 0,
        content: `# 这次共创\n判断变化：否决 PR 数守卫，因为规则会诱导拆分。 [sources: ${id}]`,
      };
      yield {
        type: 'done',
        catId: 'codex6-luna',
        timestamp: 1,
        metadata: { provider: 'openai', model: 'gpt-6-luna', usage: { inputTokens: 100, outputTokens: 20 } },
      };
    },
  };
  registry.register('codex6-luna', service);
  const previousModel = process.env.CAT_CODEX6_LUNA_MODEL;
  process.env.CAT_CODEX6_LUNA_MODEL = 'gpt-6-luna';
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session'] as string | undefined;
  });
  let spec: ReturnType<typeof createSummaryCompactionTaskSpec> | undefined;
  try {
    await evidence.upsert([
      {
        anchor: `thread-${thread.id}`,
        title: thread.title!,
        kind: 'thread',
        status: 'active',
        summary: 'HISTORICAL_SECRET',
        updatedAt: new Date().toISOString(),
      },
    ]);
    const started = Date.now() - 30 * 60_000;
    db.prepare('INSERT INTO summary_state (thread_id,pending_message_count) VALUES (?,500)').run(thread.id);
    await registerLunaCuration({
      app,
      db,
      projectRoot: root,
      ownerUserId: 'owner',
      householdTimeZone: 'UTC',
      agentRegistry: registry,
      resolveProvider: (catId) => ({ catId, model: 'gpt-6-luna', service }),
      taskRunner: {
        register: (registered) => {
          if (registered.id === 'summary-compact')
            spec = registered as ReturnType<typeof createSummaryCompactionTaskSpec>;
        },
      },
      threadStore: threads,
      messageStore: messages,
      reEmbed: async () => {},
      deliver: async (input) => messages.append({ ...input, catId: null, timestamp: Date.now(), mentions: [] }).id,
    });
    assert.equal(spec!.enabled!(), false);
    assert.equal(calls, 0);
    saveCurationPreference(root, db, { enabled: true }, started);
    const fresh = messages.append({
      threadId: thread.id,
      userId: 'owner',
      catId: null,
      mentions: [],
      content: '否决 PR 数守卫',
      timestamp: started + 1000,
    });
    const system = messages.append({
      threadId: thread.id,
      userId: 'system',
      catId: 'system',
      content: 'SYSTEM_ROW_MUST_NOT_BECOME_AN_OWNER_FACT',
      timestamp: started + 2000,
    });
    assert.equal(
      await new ThreadOverviewRepository({
        db,
        ownerUserId: 'owner',
        threadStore: threads,
        messageStore: messages,
      }).isSourceReadable(thread.id, system.id),
      false,
    );
    db.prepare(
      'UPDATE summary_state SET pending_message_count=2,pending_token_count=100,pending_signal_flags=1 WHERE thread_id=?',
    ).run(thread.id);
    const admitted = await spec!.admission.gate({ taskId: spec!.id, lastRunAt: null, tickCount: 1 });
    assert.equal(admitted.run, true);
    if (!admitted.run) throw new Error('Not admitted');
    await spec!.run.execute(admitted.workItems![0].signal, `thread-${thread.id}`, {
      signal: new AbortController().signal,
    } as Parameters<NonNullable<typeof spec>['run']['execute']>[2]);
    assert.equal(calls, 1);
    assert.ok(!prompts[0].includes('HISTORICAL_SECRET'));
    assert.ok(!prompts[0].includes('SYSTEM_ROW_MUST_NOT_BECOME_AN_OWNER_FACT'));
    assert.equal(
      parseCursor(
        (
          db.prepare('SELECT last_summarized_message_id AS id FROM summary_state WHERE thread_id=?').get(thread.id) as {
            id: string;
          }
        ).id,
      )?.id,
      system.id,
    );
    const settled = db
      .prepare(
        'SELECT pending_message_count,pending_token_count,pending_signal_flags,carry_over FROM summary_state WHERE thread_id=?',
      )
      .get(thread.id);
    assert.deepEqual(settled, {
      pending_message_count: 0,
      pending_token_count: 0,
      pending_signal_flags: 0,
      carry_over: 0,
    });
    assert.equal((await spec!.admission.gate({ taskId: spec!.id, lastRunAt: null, tickCount: 2 })).run, false);
    const persisted = db
      .prepare('SELECT summary,model_id AS model,prompt_version AS version FROM summary_segments')
      .get() as { summary: string; model: string; version: string };
    assert.match(persisted.summary, new RegExp(`${thread.id}#${fresh.id}`));
    assert.equal(persisted.model, 'gpt-6-luna');
    assert.equal(persisted.version, 'f321-luna-overview-v3');
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM evidence_fts WHERE evidence_fts MATCH '数守卫'").get() as { n: number }).n,
      1,
    );
    const operations = threads.list('owner').find((row) => row.systemKind === 'memory_ops');
    assert.ok(operations);
    assert.equal(messages.getByThread(operations.id).length, 1);
    assert.match(messages.getByThread(operations.id)[0].content, /1 个对话，1 条消息。输入 100，输出 20/);
    for (const session of [undefined, 'other', 'owner']) {
      const response = await app.inject({
        url: '/api/memory/curation',
        headers: session ? { 'x-test-session': session } : {},
      });
      assert.equal(response.statusCode, session === 'owner' ? 200 : session ? 403 : 401);
      if (session === 'owner') assert.equal(response.json().entries.length, 1);
    }
    assert.equal(
      (await app.inject({ url: '/api/memory/curation', headers: { 'x-cat-cafe-user': 'owner' } })).statusCode,
      401,
    );
    const disabled = await app.inject({
      method: 'PUT',
      url: '/api/config/memory-curation',
      headers: { 'x-test-session': 'owner' },
      payload: { enabled: false },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(spec!.enabled!(), false);
    assert.equal(
      (await app.inject({ url: '/api/memory/curation', headers: { 'x-test-session': 'owner' } })).json().entries.length,
      1,
    );
    await messages.softDelete(fresh.id, 'owner');
    assert.equal(
      (await app.inject({ url: '/api/memory/curation', headers: { 'x-test-session': 'owner' } })).json().entries.length,
      0,
    );
  } finally {
    if (previousModel === undefined) delete process.env.CAT_CODEX6_LUNA_MODEL;
    else process.env.CAT_CODEX6_LUNA_MODEL = previousModel;
    await app.close();
    await evidence.close();
    rmSync(root, { recursive: true });
  }
});

test('an unavailable operations thread cannot turn on the preference while telling the owner saving failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f321-luna-setting-failure-'));
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const threads = new ThreadStore();
  threads.ensureThread = async () => {
    throw new Error('store unavailable');
  };
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'owner';
  });
  try {
    await app.register(memoryCurationRoutes, {
      projectRoot: root,
      ownerUserId: 'owner',
      db: evidence.getDb(),
      threadStore: threads,
      messageStore: new MessageStore(),
      modelLabel: () => 'Luna',
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/config/memory-curation',
      payload: { enabled: true },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(readCurationPreference(root).enabled, false);
    assert.equal(readCurationPreference(root).startedAt, null);
  } finally {
    await app.close();
    await evidence.close();
    rmSync(root, { recursive: true });
  }
});
