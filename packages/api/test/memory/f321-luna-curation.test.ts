import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { readCurationPreference, saveCurationPreference } from '../../src/config/user-preferences-curation.js';
import { updateUserPreferences } from '../../src/config/user-preferences-store.js';
import { createLunaCurationClient } from '../../src/domains/memory/LunaCurationClient.js';
import { createSummaryCompactionTaskSpec } from '../../src/domains/memory/SummaryCompactionTaskSpec.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';

test('curation defaults off; first enable starts now and clears historical pending counts only once', () => {
  const root = mkdtempSync(join(tmpdir(), 'f321-curation-'));
  const db = new Database(':memory:');
  applyMigrations(db);
  try {
    updateUserPreferences(root, () => ({ catOrder: ['opus55'] }));
    assert.equal(readCurationPreference(root, {}).enabled, false);
    db.prepare(
      "INSERT INTO summary_state (thread_id, pending_message_count, last_summarized_message_id) VALUES ('old', 800, 'old-watermark')",
    ).run();
    const enabled = saveCurationPreference(root, db, { enabled: true }, 12345, {});
    assert.deepEqual(enabled, { enabled: true, startedAt: 12345, curatorCatId: 'codex6-luna' });
    assert.equal((db.prepare('SELECT pending_message_count AS n FROM summary_state').get() as { n: number }).n, 0);
    assert.equal(
      (db.prepare('SELECT last_summarized_message_id AS id FROM summary_state').get() as { id: string | null }).id,
      null,
    );
    assert.equal(
      readCurationPreference(root, { F321_CURATOR_CAT_ID: 'configured-cat' }).curatorCatId,
      'configured-cat',
    );
    db.prepare('UPDATE summary_state SET pending_message_count = 2').run();
    saveCurationPreference(root, db, { enabled: false }, 23456, {});
    saveCurationPreference(root, db, { enabled: true, curatorCatId: 'another-cat' }, 34567, {});
    assert.equal(readCurationPreference(root, {}).startedAt, 12345);
    assert.equal((db.prepare('SELECT pending_message_count AS n FROM summary_state').get() as { n: number }).n, 2);
    assert.deepEqual(JSON.parse(requireRead(root)).catOrder, ['opus55']);
  } finally {
    db.close();
    rmSync(root, { recursive: true });
  }
});

function requireRead(root: string) {
  return readFileSync(join(root, '.cat-cafe/user-preferences.json'), 'utf8');
}

import { readFileSync } from 'node:fs';

test('daily fallback processes one quiet new message, never backfills a historical document, and does not repeat today', async () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  try {
    db.prepare(
      "INSERT INTO evidence_docs (anchor,kind,status,title,updated_at) VALUES ('thread-history','thread','active','History',?)",
    ).run(new Date().toISOString());
    db.prepare(
      "INSERT INTO summary_state (thread_id,pending_message_count,pending_token_count,summary_type) VALUES ('new',1,10,'concat')",
    ).run();
    const spec = createSummaryCompactionTaskSpec({
      db,
      enabled: () => true,
      getThreadLastActivity: async () => null,
      getMessagesAfterWatermark: async () => [],
      generateAbstractive: async () => null,
      logger: { info() {}, error() {} },
      curation: { timezone: 'UTC', now: () => Date.parse('2026-10-07T05:00:00Z') },
    });
    const admitted = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(admitted.run, true);
    if (admitted.run) {
      assert.equal(admitted.workItems?.length, 1);
      assert.equal(admitted.workItems?.[0].signal.daily, true);
    }
    assert.equal(db.prepare("SELECT * FROM summary_state WHERE thread_id='history'").get(), undefined);
    db.prepare("UPDATE summary_state SET last_abstractive_at='2026-10-07T04:30:00Z'").run();
    assert.equal((await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 2 })).run, false);
  } finally {
    db.close();
  }
});

test('configured Luna service receives full attributed material and returns per-line sources and actual terminal usage', async () => {
  const prompts: string[] = [];
  const options: unknown[] = [];
  const client = createLunaCurationClient({
    resolveService: () => ({
      catId: 'codex6-luna',
      model: 'gpt-6-luna',
      service: {
        async *invoke(prompt, opts) {
          prompts.push(prompt);
          options.push(opts);
          yield {
            type: 'text',
            catId: 'codex6-luna',
            content:
              '# 这次合作\n判断变化：否决 PR 数守卫，规则会诱导拆分。 [sources: m1]\n值得回看：先读真实页面，再讨论布局。 [sources: m2]\n[Luna/gpt-6-luna🐾]\n\n[GPT-6 Luna/gpt-6-luna🐾]',
            timestamp: 0,
          };
          yield {
            type: 'done',
            catId: 'codex6-luna',
            timestamp: 1,
            metadata: { provider: 'openai', model: 'gpt-6-luna', usage: { inputTokens: 123, outputTokens: 45 } },
          };
        },
      },
    }),
    workingDirectory: '/tmp',
    logger: { info() {}, error() {} },
  });
  const result = await client({
    threadId: 'home',
    previousSummary: null,
    messages: [
      { id: 'm1', content: '否决', timestamp: 0 },
      { id: 'm2', content: `${'long'.repeat(500)}END_OF_REAL_MESSAGE`, timestamp: 1 },
    ],
  });
  assert.ok(prompts[0].includes('END_OF_REAL_MESSAGE'));
  assert.match((options[0] as { systemPrompt: string }).systemPrompt, /判断.*变化/);
  assert.ok(result);
  assert.match(result.segments[0].summary, /home#m1/);
  assert.match(result.segments[0].summary, /home#m2/);
  assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 45, totalTokens: 168 });
  assert.equal(result.modelId, 'gpt-6-luna');
  assert.equal((options[0] as { toolExecutionPolicy: { mode: string } }).toolExecutionPolicy.mode, 'read_only');
  assert.equal(result.segments[0].candidates?.length ?? 0, 0);
});

test('provider failure leaves input unacknowledged and reports tokens already spent', async () => {
  const usage: unknown[] = [];
  const client = createLunaCurationClient({
    resolveService: () => ({
      catId: 'codex6-luna',
      model: 'gpt-6-luna',
      service: {
        async *invoke() {
          yield { type: 'error', catId: 'codex6-luna', timestamp: 1, error: 'failure' };
          yield {
            type: 'done',
            catId: 'codex6-luna',
            timestamp: 2,
            errorCode: 'failed',
            metadata: { provider: 'openai', model: 'gpt-6-luna', usage: { inputTokens: 7, outputTokens: 2 } },
          };
        },
      },
    }),
    workingDirectory: '/tmp',
    logger: { info() {}, error() {} },
  });
  assert.equal(
    await client(
      {
        threadId: 'home',
        previousSummary: null,
        messages: [{ id: 'm1', content: 'message', timestamp: 0 }],
      },
      undefined,
      (generationUsage) => {
        usage.push(generationUsage);
      },
    ),
    null,
  );
  assert.equal((usage[0] as { totalTokens: number }).totalTokens, 9);
  assert.equal('success' in (usage[0] as object), false);
});

test('daily fallback still runs in an active conversation; event-triggered compaction keeps its quiet window', async () => {
  const { isSummaryEligible } = await import('../../src/domains/memory/summary-eligibility.js');
  const state = {
    pending_message_count: 1,
    pending_token_count: 10,
    pending_signal_flags: 1,
    carry_over: 0,
    last_abstractive_at: null,
  };
  const clock = () => 1000000;
  const activity = { lastMessageAt: clock() - 1000 };
  assert.equal(isSummaryEligible(state, activity, undefined, { now: clock }), false);
  assert.equal(isSummaryEligible(state, activity, undefined, { now: clock, daily: true }), true);
});

test('overview resumes independently and retains valid previous sources across client recreation', async () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const calls: Array<string | undefined> = [];
  const make = () =>
    createLunaCurationClient({
      db,
      ownerUserId: 'owner',
      isSourceReadable: async () => true,
      resolveService: () => ({
        catId: 'codex6-luna',
        model: 'gpt-6-luna',
        accountIdentity: 'account-a',
        service: {
          async *invoke(prompt: string, opts?: { sessionId?: string }) {
            calls.push(opts?.sessionId);
            const id = prompt.match(/\[message ([^\]]+)\]/)?.[1];
            yield { type: 'session' as const, catId: 'codex6-luna', timestamp: 0, sessionId: `native-${id?.[0]}` };
            yield {
              type: 'text' as const,
              catId: 'codex6-luna',
              timestamp: 1,
              content: `# 角色形象与纠正\n这条线程在做角色设定，保留母图约定并修正头顶形象。 [sources: ${opts?.sessionId ? 'a1, ' : ''}${id}]`,
            };
            yield {
              type: 'done' as const,
              catId: 'codex6-luna',
              timestamp: 2,
              metadata: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 60 } },
            };
          },
        },
      }),
      workingDirectory: '/tmp',
      logger: { info() {}, error() {} },
    });
  try {
    const a1 = await make()({
      threadId: 'a',
      previousSummary: null,
      messages: [{ id: 'a1', content: '母图', timestamp: 0 }],
    });
    assert.ok(a1);
    assert.ok(a1.curationState, 'successful generation must return commit-bound session state');
    const { commitCurationState } = await import('../../src/domains/memory/curation/LunaCurationState.js');
    commitCurationState(db, 'a', a1);
    const b1 = await make()({
      threadId: 'b',
      previousSummary: null,
      messages: [{ id: 'b1', content: '其他', timestamp: 1 }],
    });
    assert.ok(b1);
    commitCurationState(db, 'b', b1);
    const a2 = await make()({
      threadId: 'a',
      previousSummary: a1.segments[0].summary,
      messages: [{ id: 'a2', content: '纠正', timestamp: 2 }],
    });
    assert.ok(a2);
    commitCurationState(db, 'a', a2);
    const a3 = await make()({
      threadId: 'a',
      previousSummary: a2.segments[0].summary,
      messages: [{ id: 'a3', content: '迟到纠正', timestamp: 3 }],
    });
    assert.ok(a3);
    assert.deepEqual(calls, [undefined, undefined, 'native-a', 'native-a']);
    assert.match(a3.segments[0].summary, /a#a1/);
    assert.equal(a3.usage?.cacheReadTokens, 60);
  } finally {
    db.close();
  }
});

test('native source shorthand resolves only a unique permitted exact timestamp and suffix', async () => {
  const full = '0001791450058191-000453-dd59c0a8';
  const make = () =>
    createLunaCurationClient({
      resolveService: () => ({
        catId: 'codex6-luna',
        model: 'gpt-6-luna',
        service: {
          async *invoke() {
            yield {
              type: 'text' as const,
              catId: 'codex6-luna',
              timestamp: 0,
              content: '概况的用途发生了变化。 [sources: 0001791450058191-dd59c0a8]',
            };
            yield { type: 'done' as const, catId: 'codex6-luna', timestamp: 1 };
          },
        },
      }),
      workingDirectory: '/tmp',
      logger: { info() {}, error() {} },
    });
  const input = { threadId: 'home', previousSummary: null, messages: [{ id: full, content: '用途', timestamp: 0 }] };
  const result = await make()(input);
  assert.ok(result);
  assert.match(result.segments[0].summary, new RegExp(full));
  assert.equal(await make()({ ...input, messages: [{ ...input.messages[0], id: 'unknown' }] }), null);
  assert.equal(
    await make()({
      ...input,
      messages: [...input.messages, { ...input.messages[0], id: '0001791450058191-000999-dd59c0a8' }],
    }),
    null,
  );
});

test('a cancelled resume never bills the previous stored token count as a fresh attempt', async () => {
  const { runLunaNative } = await import('../../src/domains/memory/curation/LunaNativeRun.js');
  const run = await runLunaNative({
    provider: {
      catId: 'codex6-luna',
      model: 'gpt-6-luna',
      service: {
        async *invoke() {
          yield {
            type: 'status',
            catId: 'codex6-luna',
            timestamp: 0,
            metadata: { usage: { inputTokens: 800, outputTokens: 90 } },
          };
          yield { type: 'error', catId: 'codex6-luna', timestamp: 1, error: 'cancelled' };
          yield { type: 'done', catId: 'codex6-luna', timestamp: 2, errorCode: 'cancelled' };
        },
      },
    },
    prompt: 'new round',
    instructions: 'overview',
    workingDirectory: '/tmp',
    sessionId: 'stored-session',
  });
  assert.equal(run.success, false);
  assert.equal(run.usage, undefined);
});

test('anonymous legacy text is never fed to Luna as retained narrative merely because it contains a valid citation', async () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  const prompts: string[] = [];
  const previous = 'UNATTRIBUTED_PRIVATE_BODY （来源：a#old）';
  db.prepare(
    "INSERT INTO thread_curation_state(owner_user_id,thread_id,provider_identity,summary_revision,directory_line) VALUES ('owner','a','initializing',?,'')",
  ).run((await import('../../src/domains/memory/curation/LunaCurationState.js')).overviewRevision(previous));
  try {
    const client = createLunaCurationClient({
      db,
      ownerUserId: 'owner',
      workingDirectory: '/tmp',
      isSourceReadable: async () => true,
      logger: { info() {}, error() {} },
      resolveService: () => ({
        catId: 'codex6-luna',
        model: 'gpt-6-luna',
        service: {
          async *invoke(prompt) {
            prompts.push(prompt);
            yield { type: 'text', catId: 'codex6-luna', timestamp: 0, content: '# 新线索\n新经历 [sources: new]' };
            yield { type: 'done', catId: 'codex6-luna', timestamp: 1 };
          },
        },
      }),
    });
    assert.ok(
      await client({
        threadId: 'a',
        previousSummary: previous,
        messages: [{ id: 'new', content: 'new public experience', timestamp: 1 }],
      }),
    );
    assert.ok(!prompts[0].includes('UNATTRIBUTED_PRIVATE_BODY'));
  } finally {
    db.close();
  }
});
