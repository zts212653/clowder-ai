import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECALL_RESOLVER_FAMILIES } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryCueInvocationPromptService } from '../../src/domains/memory/cue/MemoryCueInvocationPromptService.js';
import { MemoryCuePlaneService } from '../../src/domains/memory/cue/MemoryCuePlaneService.js';
import { MemoryCueResolverRegistry } from '../../src/domains/memory/cue/MemoryCueResolverRegistry.js';
import { ThreadOverviewMemoryCueSource } from '../../src/domains/memory/cue/sources/ThreadOverviewMemoryCueSource.js';
import { LunaThreadLibrarian } from '../../src/domains/memory/curation/LunaThreadLibrarian.js';
import { ThreadOverviewRepository } from '../../src/domains/memory/curation/ThreadOverviewRepository.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';

function fixture() {
  const db = new Database(':memory:');
  applyMigrations(db);
  const threads = new ThreadStore();
  const messages = new MessageStore();
  const thread = threads.create('owner', 'new idea');
  const opening = messages.append({
    threadId: thread.id,
    userId: 'owner',
    catId: null,
    content: 'new idea',
    timestamp: 1,
  });
  const repository = new ThreadOverviewRepository({
    db,
    ownerUserId: 'owner',
    threadStore: threads,
    messageStore: messages,
  });
  return { db, threads, messages, thread, opening, repository };
}

test('caller Stop crosses prompt, plane and source into native Luna; late output cannot start later capacity batches', async () => {
  const f = fixture();
  const controller = new AbortController();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  let nativeSignal: AbortSignal | undefined;
  try {
    f.repository.directory = async () => ({
      // Five capacity batches: four may be in flight, the fifth must never start after Stop.
      entries: Array.from({ length: 5 }, (_, i) => ({
        threadId: `old-${i}`,
        revision: 'r',
        line: 'x'.repeat(360_000),
        coverage: 'missing' as const,
      })),
      coverage: { readable: 5, overview: 0, legacy: 0, missing: 5 },
    });
    const librarian = new LunaThreadLibrarian({
      repository: f.repository,
      workingDirectory: '/tmp',
      timeoutMs: 1000,
      resolveProvider: () => ({
        catId: 'codex6-luna',
        model: 'gpt-6-luna',
        service: {
          async *invoke(_prompt, options) {
            calls++;
            nativeSignal = options?.signal;
            started();
            // Deliberately ignore abort to verify chat still settles promptly.
            await blocked;
            yield { type: 'text', catId: 'codex6-luna', timestamp: 0, content: '{"related":[]}' };
            yield { type: 'done', catId: 'codex6-luna', timestamp: 1 };
          },
        },
      }),
    });
    const source = new ThreadOverviewMemoryCueSource({
      repository: f.repository,
      librarian,
      messageStore: f.messages,
      enabled: () => true,
    });
    const registry = new MemoryCueResolverRegistry(
      RECALL_RESOLVER_FAMILIES.map((family) =>
        family === 'thread_overview' ? source : { family, resolverVersion: 1, resolve: async () => [] },
      ),
    );
    const service = new MemoryCueInvocationPromptService({
      plane: new MemoryCuePlaneService(registry),
      createDrillHandle: () => 'handle',
    });
    const scope = { ownerUserId: 'owner', threadId: f.thread.id, invocationId: 'inv' };
    const pending = service.resolve({
      serverScope: scope,
      consumerCatId: 'codex61-sol',
      now: 2,
      signal: controller.signal,
      seeds: [
        { kind: 'thread_opened', producer: 'owner_message', occurredAt: 1, payload: { sourceMessageId: f.opening.id } },
      ],
    });
    await entered;
    controller.abort(new Error('owner Stop'));
    const start = Date.now();
    await assert.rejects(pending, /owner Stop/);
    assert.ok(Date.now() - start < 300, 'Stop must not wait for the native local deadline');
    assert.equal(nativeSignal?.aborted, true);
    assert.equal(calls, 4);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 4, 'late native output cannot schedule the fifth batch');
  } finally {
    release();
    f.db.close();
  }
});

test('canceling a directory read prevents reads of subsequent historical threads', async () => {
  const f = fixture();
  const controller = new AbortController();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reads = 0;
  try {
    for (let n = 0; n < 5; n++) {
      const old = f.threads.create('owner', `old ${n}`);
      f.db
        .prepare(
          "INSERT INTO evidence_docs(anchor,kind,status,title,summary,updated_at) VALUES (?,'thread','active','old','legacy','now')",
        )
        .run(`thread-${old.id}`);
    }
    const original = f.messages.getByThread.bind(f.messages);
    f.messages.getByThread = async (...args) => {
      reads++;
      started();
      await blocked;
      return original(...args);
    };
    const pending = f.repository.directory('owner', 'codex61-sol', f.thread.id, controller.signal);
    await entered;
    controller.abort();
    release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(reads, 1);
  } finally {
    release();
    f.db.close();
  }
});

test('already canceled recall performs no directory reads or model calls', async () => {
  const f = fixture();
  let reads = 0;
  const controller = new AbortController();
  controller.abort();
  try {
    f.repository.directory = async () => {
      reads++;
      return { entries: [], coverage: { readable: 0, overview: 0, legacy: 0, missing: 0 } };
    };
    const librarian = new LunaThreadLibrarian({
      repository: f.repository,
      workingDirectory: '/tmp',
      resolveProvider: () => {
        throw new Error('must not invoke');
      },
    });
    assert.deepEqual(
      await librarian.recall({
        ownerUserId: 'owner',
        consumerCatId: 'codex61-sol',
        threadId: f.thread.id,
        opening: 'idea',
        signal: controller.signal,
      }),
      [],
    );
    assert.equal(reads, 0);
  } finally {
    f.db.close();
  }
});
