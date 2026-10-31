/** Browser samples use the captured real Luna result, the production commit, and owner routes. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { saveCurationPreference } from '../../src/config/user-preferences-curation.js';
import type { StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { toAbstractiveMessages } from '../../src/domains/memory/abstractive-summary-input.js';
import type { AbstractiveResult } from '../../src/domains/memory/abstractive-summary-types.js';
import { ensureMemoryOperationsThread } from '../../src/domains/memory/MemoryOperationsThread.js';
import { SqliteEvidenceStore } from '../../src/domains/memory/SqliteEvidenceStore.js';
import { processThread } from '../../src/domains/memory/SummaryCompactionTask.js';
import { SUMMARY_CONFIG } from '../../src/domains/memory/summary-config.js';
import { memoryCurationRoutes } from '../../src/routes/memory-curation.js';

const root = mkdtempSync(join(tmpdir(), 'f321-luna-browser-'));
const native = JSON.parse(
  readFileSync(
    new URL('../../../../docs/evidence/2026-10-07-f321-luna-v1/native-result.json', import.meta.url),
    'utf8',
  ),
) as { result: AbstractiveResult };
const messages: StoredMessage[] = ['quote-comment', 'long-message'].map((name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/f321-${name}.json`, import.meta.url), 'utf8')),
);
const owner = messages[0].userId;
const threadId = messages[0].threadId;
const source = { getById: async (id: string) => messages.find((message) => message.id === id) ?? null };
const evidence = new SqliteEvidenceStore(':memory:');
await evidence.initialize();
const db = evidence.getDb();
const threads = new ThreadStore();
await threads.ensureThread(threadId, 'PR 数守卫与记忆输入');
await threads.indexForUser(threadId, owner);
await ensureMemoryOperationsThread(threads, owner);
const app = Fastify();
app.addHook('preHandler', async (request) => {
  request.sessionUserId = request.headers['x-test-session'] as string | undefined;
});
try {
  saveCurationPreference(root, db, { enabled: true }, messages[0].timestamp - 1000);
  await evidence.upsert([
    {
      anchor: `thread-${threadId}`,
      kind: 'thread',
      status: 'active',
      title: 'PR 数守卫与记忆输入',
      updatedAt: new Date().toISOString(),
    },
  ]);
  db.prepare('INSERT INTO summary_state (thread_id,pending_message_count,pending_signal_flags) VALUES (?,2,1)').run(
    threadId,
  );
  const state = db.prepare('SELECT * FROM summary_state').get() as Parameters<typeof processThread>[0];
  const input = await toAbstractiveMessages(messages, source);
  assert.equal(
    await processThread(
      state,
      {
        db,
        enabled: () => true,
        getThreadLastActivity: async () => null,
        getMessagesAfterWatermark: async (_thread, after) => (after ? [] : input),
        generateAbstractive: async () => native.result,
        logger: { info() {}, error() {} },
      },
      SUMMARY_CONFIG,
    ),
    true,
  );
  await app.register(memoryCurationRoutes, {
    projectRoot: root,
    ownerUserId: owner,
    db,
    threadStore: threads,
    messageStore: source,
    modelLabel: () => '缅因猫 Luna',
  });
  const samples: Record<string, { status: number; body: unknown }> = {};
  const capture = async (key: string, url: string, method: 'GET' | 'PUT' = 'GET', payload?: { enabled: boolean }) => {
    const response = await app.inject({
      url,
      method,
      headers: { 'x-test-session': owner },
      ...(payload ? { payload } : {}),
    });
    samples[key] = { status: response.statusCode, body: response.json() };
    assert.equal(response.statusCode, 200);
  };
  await capture('ready', '/api/memory/curation');
  assert.equal((samples.ready.body as { entries: unknown[] }).entries.length, 1);
  await capture('settings', '/api/config/memory-curation');
  await capture('settingsOff', '/api/config/memory-curation', 'PUT', { enabled: false });
  await capture('off', '/api/memory/curation');
  db.prepare('DELETE FROM summary_segments').run();
  await capture('empty', '/api/memory/curation');
  console.log(`F321_LUNA_BROWSER_JSON=${JSON.stringify(samples)}`);
} finally {
  await app.close();
  await evidence.close();
  rmSync(root, { recursive: true });
}
