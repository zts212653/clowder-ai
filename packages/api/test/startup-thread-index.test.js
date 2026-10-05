import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { IndexBuilder } from '../dist/domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('startup thread index catch-up', () => {
  let root, docs, store, builder, threads, messages, reads, readMessages;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'startup-thread-index-'));
    docs = join(root, 'docs');
    mkdirSync(join(docs, 'features'), { recursive: true });
    writeFileSync(join(docs, 'features', 'F001.md'), '---\nfeature_ids: [F001]\n---\n# Startup document\n');
    store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
    await store.initialize();
    threads = [{ id: 'chat', title: 'Existing chat', participants: ['codex'], lastActiveAt: 1000 }];
    messages = [{ id: 'old', threadId: 'chat', content: 'oldsearchablebody', catId: 'codex', timestamp: 1000 }];
    reads = 0;
    readMessages = async () => messages;
    builder = new IndexBuilder(
      store,
      docs,
      undefined,
      undefined,
      async () => threads,
      async (...args) => {
        reads++;
        return readMessages(...args);
      },
    );
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves a persisted thread index without reading message history before listen', async () => {
    await builder.rebuild();
    reads = 0;
    await builder.rebuild({ deferThreadIndexing: true });
    assert.equal(reads, 0, 'startup must not hydrate every chat before the socket can listen');
    assert.ok(await store.getByAnchor('thread-chat'));
    assert.equal(store.searchPassages('oldsearchablebody').length, 1);
    assert.ok(await store.getByAnchor('F001'));
  });

  it('catches up an empty database after the document-only startup pass', async () => {
    await builder.rebuild({ deferThreadIndexing: true });
    assert.equal(reads, 0);
    assert.equal(await store.getByAnchor('thread-chat'), null);
    await builder.refreshThreadIndex();
    assert.ok(await store.getByAnchor('thread-chat'));
    assert.equal(store.searchPassages('oldsearchablebody').length, 1);
    assert.ok(await store.getByAnchor('F001'), 'thread catch-up must not prune documents');
  });

  it('yields to I/O while unchanged history catches up and does not rebuild unchanged entity mentions', async () => {
    await builder.rebuild();
    const refresh = store.refreshEntityMentions.bind(store);
    let entityRefreshes = 0;
    store.refreshEntityMentions = async (...args) => {
      entityRefreshes++;
      return refresh(...args);
    };
    let ioRan = false;
    const io = yieldTurn().then(() => {
      ioRan = true;
    });
    await builder.refreshThreadIndex();
    assert.equal(ioRan, true);
    assert.equal(entityRefreshes, 0, 'unchanged passage batches should not rescan all entity mentions');
    await io;
  });

  it('retains dirty notifications received during catch-up and updates their passages afterwards', async () => {
    await builder.rebuild();
    const entered = deferred(),
      release = deferred();
    let first = true;
    readMessages = async () => {
      if (!first) return messages;
      first = false;
      const snapshot = messages.slice();
      entered.resolve();
      await release.promise;
      return snapshot;
    };
    const catchUp = builder.refreshThreadIndex();
    await entered.promise;
    messages.push({ id: 'new', threadId: 'chat', content: 'newsearchablebody', timestamp: 2000 });
    builder.markThreadDirty('chat');
    try {
      assert.equal(await builder.flushDirtyThreads(), 0, 'timer flush should wait without consuming dirty IDs');
    } finally {
      release.resolve();
    }
    await catchUp;
    await builder.flushDirtyThreads();
    assert.equal(store.searchPassages('newsearchablebody').length, 1);
  });

  it('cancels before writing a message snapshot fetched during shutdown', async () => {
    await builder.rebuild();
    const controller = new AbortController(),
      entered = deferred(),
      release = deferred();
    readMessages = async () => {
      entered.resolve();
      await release.promise;
      return [{ id: 'cancelled', threadId: 'chat', content: 'cancelledbody', timestamp: 2000 }];
    };
    const catchUp = builder.refreshThreadIndex({ signal: controller.signal });
    const rejected = assert.rejects(catchUp, { name: 'AbortError' });
    await entered.promise;
    controller.abort();
    release.resolve();
    await rejected;
    assert.equal(store.searchPassages('cancelledbody').length, 0);
    assert.equal((await store.getByAnchor('thread-chat')).summary.includes('oldsearchablebody'), true);
  });

  it('does not resurrect a message recalled while history was being fetched', async () => {
    await builder.rebuild();
    const entered = deferred(),
      release = deferred();
    let first = true;
    readMessages = async () => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return messages;
    };
    const catchUp = builder.refreshThreadIndex();
    await entered.promise;
    try {
      await builder.suppressMessagePassage('chat', 'old');
    } finally {
      release.resolve();
    }
    await catchUp;
    await builder.flushDirtyThreads();
    assert.equal(store.searchPassages('oldsearchablebody').length, 0);
    const item = await store.getByAnchor('thread-chat');
    assert.equal(item.summary.includes('oldsearchablebody'), false);
  });

  it('checks recall again when a stale summary reaches the queued writer', async () => {
    await builder.rebuild();
    const releaseWriter = deferred(),
      summaryQueued = deferred();
    const upsert = store.upsert.bind(store);
    store.upsert = (...args) => {
      summaryQueued.resolve();
      return upsert(...args);
    };
    const writer = store.runExclusive(() => releaseWriter.promise);
    const recall = builder.suppressMessagePassage('chat', 'old');
    // Force a different projection so the background pass must enqueue a write.
    threads[0].title = 'Updated title';
    const catchUp = builder.refreshThreadIndex();
    await summaryQueued.promise;
    releaseWriter.resolve();
    await Promise.all([writer, recall, catchUp]);
    await builder.flushDirtyThreads();
    assert.equal(store.searchPassages('oldsearchablebody').length, 0);
    assert.equal((await store.getByAnchor('thread-chat')).summary.includes('oldsearchablebody'), false);
  });

  it('checks recall inside the passage transaction after a suspended history read', async () => {
    await builder.rebuild();
    const entered = deferred(),
      release = deferred();
    readMessages = async (_id, limit) => {
      if (limit === 2000) {
        entered.resolve();
        await release.promise;
      }
      return messages;
    };
    const catchUp = builder.refreshThreadIndex();
    await entered.promise;
    try {
      await builder.suppressMessagePassage('chat', 'old');
    } finally {
      release.resolve();
    }
    await catchUp;
    assert.equal(store.searchPassages('oldsearchablebody').length, 0);
  });

  it('waits for an existing dirty flush before beginning a startup snapshot', async () => {
    await builder.rebuild();
    const entered = deferred(),
      release = deferred();
    let first = true;
    readMessages = async () => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return messages;
    };
    builder.markThreadDirty('chat');
    const flush = builder.flushDirtyThreads();
    await entered.promise;
    const readsBeforeCatchUp = reads;
    const catchUp = builder.refreshThreadIndex();
    await yieldTurn();
    try {
      assert.equal(reads, readsBeforeCatchUp);
    } finally {
      release.resolve();
    }
    await Promise.all([flush, catchUp]);
    assert.equal(store.searchPassages('oldsearchablebody').length, 1);
  });

  it('keeps persisted history when listing threads fails, then retries successfully', async () => {
    await builder.rebuild();
    const recovered = threads;
    builder = new IndexBuilder(
      store,
      docs,
      undefined,
      undefined,
      async () => {
        if (!threads) throw new Error('temporarily unavailable');
        return threads;
      },
      async () => messages,
    );
    threads = null;
    await assert.rejects(builder.refreshThreadIndex(), /temporarily unavailable/);
    assert.ok(await store.getByAnchor('thread-chat'));
    threads = recovered;
    messages.push({ id: 'retry', threadId: 'chat', content: 'retrysearchablebody', timestamp: 3000 });
    await builder.refreshThreadIndex();
    assert.equal(store.searchPassages('retrysearchablebody').length, 1);
  });
});
