/**
 * SessionSealer handoff digest integration tests — F065 Phase C Task 3
 *
 * Tests that SessionSealer.finalize() generates and writes handoff digest
 * when bootstrapDepth is 'generative' and API key is available.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('SessionSealer handoff digest integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sealer-handoff-'));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  async function createFixtures(handoffConfig) {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');

    const store = new SessionChainStore();
    const writer = new TranscriptWriter({ dataDir: tempDir });
    const reader = new TranscriptReader({ dataDir: tempDir });

    // Minimal threadStore mock
    const threadMemories = new Map();
    const threadStore = {
      get: async (threadId) => ({ threadId, projectPath: '/test/project' }),
      getThreadMemory: async (threadId) => threadMemories.get(threadId) ?? null,
      updateThreadMemory: async (threadId, memory) => {
        threadMemories.set(threadId, memory);
      },
    };

    const sealer = new SessionSealer(store, writer, threadStore, reader, handoffConfig);

    return { store, writer, reader, sealer };
  }

  test('generates and writes handoff digest when bootstrapDepth=generative', async () => {
    let fetchCalled = false;
    const handoffConfig = {
      getBootstrapDepth: (_catId) => 'generative',
      resolveProfile: async (_threadId, _catId) => ({
        apiKey: 'sk-test',
        baseUrl: 'https://api.anthropic.com',
      }),
      fetchFn: async () => {
        fetchCalled = true;
        return {
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: '## Session Summary\nDid great work.' }],
          }),
        };
      },
    };

    const { store, writer, sealer } = await createFixtures(handoffConfig);
    const record = store.create({
      cliSessionId: 'cli-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    // Append some events so transcript flush writes files
    writer.appendEvent(
      { sessionId: record.id, threadId: 'thread-1', catId: 'opus', cliSessionId: 'cli-1', seq: 0 },
      { type: 'text', content: 'Hello world' },
    );

    await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' });
    await sealer.finalize({ sessionId: record.id });

    assert.ok(fetchCalled, 'should have called Haiku API');

    // Check handoff digest was written
    const sessionDir = join(tempDir, 'threads', 'thread-1', 'opus', 'sessions', record.id);
    const handoffPath = join(sessionDir, 'digest.handoff.md');
    const content = await readFile(handoffPath, 'utf-8');
    assert.ok(content.includes('Session Summary'));
    assert.ok(content.includes('v: 1'));
  });

  test('skips handoff when bootstrapDepth=extractive', async () => {
    let fetchCalled = false;
    const handoffConfig = {
      getBootstrapDepth: (_catId) => 'extractive',
      resolveProfile: async () => ({ apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com' }),
      fetchFn: async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ content: [] }) };
      },
    };

    const { store, writer, sealer } = await createFixtures(handoffConfig);
    const record = store.create({
      cliSessionId: 'cli-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    writer.appendEvent(
      { sessionId: record.id, threadId: 'thread-1', catId: 'opus', cliSessionId: 'cli-1', seq: 0 },
      { type: 'text', content: 'Hello' },
    );

    await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' });
    await sealer.finalize({ sessionId: record.id });

    assert.equal(fetchCalled, false, 'should NOT call Haiku for extractive cat');
  });

  test('skips handoff when no API key available', async () => {
    let fetchCalled = false;
    const handoffConfig = {
      getBootstrapDepth: (_catId) => 'generative',
      resolveProfile: async () => null,
      fetchFn: async () => {
        fetchCalled = true;
        return { ok: true, json: async () => ({ content: [] }) };
      },
    };

    const { store, writer, sealer } = await createFixtures(handoffConfig);
    const record = store.create({
      cliSessionId: 'cli-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    writer.appendEvent(
      { sessionId: record.id, threadId: 'thread-1', catId: 'opus', cliSessionId: 'cli-1', seq: 0 },
      { type: 'text', content: 'Hello' },
    );

    await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' });
    await sealer.finalize({ sessionId: record.id });

    assert.equal(fetchCalled, false, 'should NOT call Haiku without API key');
  });

  test('handoff generation failure seals the session as terminal partial', async () => {
    const handoffConfig = {
      getBootstrapDepth: (_catId) => 'generative',
      resolveProfile: async () => ({ apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com' }),
      fetchFn: async () => {
        throw new Error('Network failure');
      },
    };

    const { store, writer, sealer } = await createFixtures(handoffConfig);
    const record = store.create({
      cliSessionId: 'cli-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });

    writer.appendEvent(
      { sessionId: record.id, threadId: 'thread-1', catId: 'opus', cliSessionId: 'cli-1', seq: 0 },
      { type: 'text', content: 'Hello' },
    );

    await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' });
    const result = await sealer.finalize({ sessionId: record.id });

    const finalRecord = store.get(record.id);
    assert.equal(finalRecord?.status, 'sealed', 'session should still seal on handoff failure');
    assert.deepEqual(result, { sealed: true, clean: false });
  });
});
