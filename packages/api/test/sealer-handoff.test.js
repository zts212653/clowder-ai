/** Sealing is extractive; legacy bootstrap preferences never enable model generation. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { SessionSealer } from '../dist/domains/cats/services/session/SessionSealer.js';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';

describe('sealing without hidden generation', () => {
  let directory;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sealer-handoff-'));
  });
  afterEach(async () => {
    mock.restoreAll();
    await rm(directory, { recursive: true });
  });

  for (const bootstrapDepth of ['generative', 'extractive']) {
    test(`${bootstrapDepth} policy preserves extractive digest, ThreadMemory and post-seal hooks without network`, async () => {
      const network = mock.method(globalThis, 'fetch', async () => {
        throw new Error('no provider allowed');
      });
      const store = new SessionChainStore();
      const threads = new ThreadStore();
      const thread = threads.create('user-1', 'Historical policy');
      const writer = new TranscriptWriter({ dataDir: directory });
      const reader = new TranscriptReader({ dataDir: directory });
      const sealer = new SessionSealer(store, writer, threads, reader);
      const hooks = [];
      sealer.registerPostSealHook(async (event) => {
        hooks.push(event);
      });
      const record = store.create({
        cliSessionId: 'cli-1',
        threadId: thread.id,
        catId: 'opus',
        userId: 'user-1',
        appliedPolicy: {
          config: {
            strategy: 'handoff',
            thresholds: { warn: 0.7, action: 0.85 },
            handoff: { preSealMemoryDump: false, bootstrapDepth },
          },
          source: 'config_file',
          revision: 'historical-policy',
          changedAt: 1,
          execution: { status: 'active', missingCapabilities: [] },
        },
      });
      writer.appendEvent(
        { sessionId: record.id, threadId: thread.id, catId: 'opus', cliSessionId: 'cli-1', seq: 0 },
        { type: 'text', content: 'We decided to keep source coordinates.' },
      );
      assert.equal((await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' })).accepted, true);
      assert.deepEqual(await sealer.finalize({ sessionId: record.id }), { sealed: true, clean: true });
      assert.equal(network.mock.callCount(), 0);
      assert.equal(store.get(record.id).status, 'sealed');
      assert.ok(await reader.readDigest(record.id, thread.id, 'opus'));
      assert.ok(threads.getThreadMemory(thread.id));
      assert.equal(await reader.readHandoffDigest(record.id, thread.id, 'opus'), null);
      assert.deepEqual(
        hooks.map((event) => [event.sessionId, event.ownerUserId]),
        [[record.id, 'user-1']],
      );
    });
  }

  test('finalizing an archived session leaves historical handoff bytes unchanged', async () => {
    const store = new SessionChainStore();
    const writer = new TranscriptWriter({ dataDir: directory });
    const reader = new TranscriptReader({ dataDir: directory });
    const sealer = new SessionSealer(store, writer);
    const record = store.create({ cliSessionId: 'cli-1', threadId: 't1', catId: 'opus', userId: 'u1' });
    writer.appendEvent(
      { sessionId: record.id, threadId: 't1', catId: 'opus', cliSessionId: 'cli-1', seq: 0 },
      { type: 'text', content: 'Archive' },
    );
    await sealer.requestSeal({ sessionId: record.id, reason: 'manual' });
    await sealer.finalize({ sessionId: record.id });
    const path = join(reader.getSessionDir('t1', 'opus', record.id), 'digest.handoff.md');
    const historical = '---\nv: 1\nmodel: historical\ngeneratedAt: 1\n---\n\nOriginal handoff\n';
    await writeFile(path, historical);
    await sealer.finalize({ sessionId: record.id });
    assert.equal(await readFile(path, 'utf8'), historical);
    assert.equal((await reader.readHandoffDigest(record.id, 't1', 'opus')).model, 'historical');
  });
});
