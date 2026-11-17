import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MatterMemoryService } from '../../dist/domains/memory/matters/MatterMemoryService.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

const reader = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };
const writer = { userId: 'owner', viewer: { type: 'cat', catId: 'codex-astra' } };
const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('matter source projection preserves the serial permission and failure boundaries', () => {
  let directory, evidence, service, messages, sequence, onRead, started, active, maxActive;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'matter-source-projection-'));
    evidence = new SqliteEvidenceStore(join(directory, 'memory.sqlite'));
    await evidence.initialize();
    messages = new Map();
    sequence = 0;
    started = [];
    active = 0;
    maxActive = 0;
    onRead = (id) => messages.get(id) ?? null;
    service = new MatterMemoryService({
      db: evidence.getDb(),
      runWrite: (operation) => evidence.runExclusive(operation),
      messageStore: {
        getById: async (id) => {
          started.push(id);
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            return await onRead(id);
          } finally {
            active--;
          }
        },
      },
      threadStore: { get: (id) => ({ id, createdBy: 'owner' }), list: () => [] },
    });
  });
  afterEach(async () => {
    await evidence.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function create(count, title = 'Matter', sourceKind = 'quote') {
    const sources = Array.from({ length: count }, () => {
      const id = `message-${sequence++}`;
      const message = {
        id,
        threadId: 'thread',
        userId: 'owner',
        from: { kind: 'user', userId: 'owner' },
        catId: null,
        content: `Original ${id}`,
        timestamp: 1,
        mentions: [],
      };
      messages.set(id, message);
      if (sourceKind === 'message') return { threadId: message.threadId, messageId: id };
      return {
        threadId: message.threadId,
        messageId: id,
        segment: 'body',
        start: 0,
        end: message.content.length,
        quote: message.content,
      };
    });
    const receipt = await service.write(writer, {
      operation: 'create',
      requestId: `create-${sequence++}`,
      title,
      description: 'Shared interpretation',
      ...(sourceKind === 'message' ? { summary: 'Pointer interpretation' } : {}),
      sources,
    });
    // Canonical entries are ordered by entry_id (UUID), not source creation order.
    const entries = service.store.entries(receipt.matter.matterId);
    started.length = 0;
    maxActive = 0;
    return { matterId: receipt.matter.matterId, entries, ids: entries.map((entry) => entry.source.messageId) };
  }

  for (const sourceKind of ['quote', 'message']) {
    it(`keeps ${sourceKind} source order through reversed completion and never exceeds four in-flight reads`, async () => {
      const { matterId, entries, ids } = await create(9, 'Matter', sourceKind);
      const gates = new Map(ids.map((id) => [id, deferred()]));
      onRead = (id) => gates.get(id).promise;
      const pending = service.project(reader, matterId);
      try {
        for (let offset = 0; offset < ids.length; offset += 4) {
          // Each get is now blocked on its explicit gate; no timer guesses a completion window.
          await drainMicrotasks();
          const end = Math.min(offset + 4, ids.length);
          assert.deepEqual(started, ids.slice(0, end));
          assert.equal(active, end - offset);
          for (const id of ids.slice(offset, end).reverse()) gates.get(id).resolve(messages.get(id));
        }
        const page = await pending;
        assert.deepEqual(
          page.entries.map((entry) => entry.entryId),
          entries.map((entry) => entry.entryId),
        );
        assert.deepEqual(
          page.entries.map((entry) => entry.quote),
          ids.map((id) => (sourceKind === 'quote' ? messages.get(id).content : undefined)),
        );
        assert.equal(maxActive, 4);
      } finally {
        for (const id of ids) gates.get(id).resolve(messages.get(id));
        await pending.catch(() => {});
      }
    });
  }

  it('checks a private page guard before starting either source branch or exposing a saved write', async () => {
    for (const sourceKind of ['quote', 'message']) {
      const { matterId } = await create(5, 'Guarded page', sourceKind);
      messages.set('private-trigger', {
        ...messages.values().next().value,
        id: 'private-trigger',
        visibility: 'whisper',
        whisperTo: ['codex-astra'],
      });
      const receipt = await service.write(
        { ...writer, invocation: { threadId: 'thread', triggerMessageId: 'private-trigger' } },
        {
          operation: 'edit',
          requestId: `guard-${sourceKind}`,
          matterId,
          expectedRevision: 1,
          title: 'Private page context',
          description: 'A private interpretation',
        },
      );
      started.length = 0;
      assert.equal(await service.project(reader, matterId), null);
      assert.deepEqual(started, ['private-trigger']);
      await assert.rejects(service.writeSnapshot(reader, matterId, receipt.writeRef), /not_available/);
      assert.deepEqual(started, ['private-trigger', 'private-trigger']);
    }
  });

  it('rejects the whole page for an unreadable source across batch boundaries and stops subsequent batches', async () => {
    for (const hiddenIndex of [0, 3, 4, 5, 8]) {
      const { matterId, ids } = await create(9);
      messages.get(ids[hiddenIndex]).visibility = 'whisper';
      messages.get(ids[hiddenIndex]).whisperTo = ['codex-astra'];
      assert.equal(await service.project(reader, matterId), null);
      const end = Math.min(Math.floor(hiddenIndex / 4) * 4 + 4, ids.length);
      assert.deepEqual(started, ids.slice(0, end));
      await assert.rejects(service.read(reader, matterId), (err) => err.code === 'not_available');
    }
  });

  it('cancels in-flight siblings without issuing the next batch', async () => {
    const { matterId, ids } = await create(9);
    const gates = new Map(ids.map((id) => [id, deferred()]));
    const controller = new AbortController();
    const reason = new Error('caller left');
    onRead = (id) => gates.get(id).promise;
    const pending = service.project({ ...reader, signal: controller.signal }, matterId);
    try {
      await drainMicrotasks();
      assert.deepEqual(started, ids.slice(0, 4));
      controller.abort(reason);
      for (const id of ids.slice(0, 4)) gates.get(id).resolve(messages.get(id));
      await assert.rejects(pending, (err) => err === reason);
      await drainMicrotasks();
      assert.deepEqual(started, ids.slice(0, 4));
      assert.equal(active, 0);
    } finally {
      for (const id of ids) gates.get(id).resolve(messages.get(id));
      await pending.catch(() => {});
    }
  });

  it('keeps an earlier unreadable source from turning a later reader fault into a directory failure', async () => {
    const { matterId, ids } = await create(4, 'Hidden page');
    await create(1, 'Visible page');
    messages.get(ids[0]).userId = 'another-owner';
    onRead = (id) => {
      if (id === ids[2]) throw new Error('later reader fault');
      return messages.get(id);
    };
    assert.equal(await service.project(reader, matterId), null);
    const catalog = await service.catalog(reader);
    assert.deepEqual(
      catalog.items.map((item) => item.title),
      ['Visible page'],
    );
  });

  it('still reports a reader fault that precedes the unreadable source in canonical order', async () => {
    const { matterId, ids } = await create(4);
    const err = new Error('earlier reader fault');
    messages.get(ids[2]).userId = 'another-owner';
    onRead = (id) => {
      if (id === ids[0]) throw err;
      return messages.get(id);
    };
    await assert.rejects(service.project(reader, matterId), (reason) => reason === err);
  });

  it('removes a page when a later-batch source is revoked during the final recheck', async () => {
    const revoked = await create(9, 'Revoked page');
    await create(2, 'Stable page');
    const target = revoked.ids[8];
    let reads = 0;
    onRead = (id) => {
      if (id === target && ++reads === 2) messages.get(id).userId = 'another-owner';
      return messages.get(id);
    };
    const catalog = await service.catalog(reader);
    assert.deepEqual(
      catalog.items.map((item) => item.title),
      ['Stable page'],
    );
    assert.equal(reads, 2);
  });
});
