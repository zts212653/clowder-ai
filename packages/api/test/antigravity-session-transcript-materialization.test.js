import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

function makeDeps(overrides = {}) {
  let counter = 0;
  return {
    registry: {
      create: () => ({ invocationId: `inv-f211-transcript-${++counter}`, callbackToken: `tok-${counter}` }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
    ...overrides,
  };
}

async function waitForDigest(reader, sessionId, threadId, catId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const digest = await reader.readDigest(sessionId, threadId, catId);
    if (digest) return digest;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

describe('F211 A2 Antigravity session transcript materialization', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'f211-antigravity-transcript-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('rotated Antigravity session transcript keeps text, lifecycle, tool evidence, and seal reason digest', async () => {
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
    const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');

    const threadId = 'thread-f211-transcript';
    const catId = 'antig-opus';
    const sessionChainStore = new SessionChainStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const transcriptWriter = new TranscriptWriter({ dataDir: tmpDir });
    const transcriptReader = new TranscriptReader({ dataDir: tmpDir });
    const sessionSealer = new SessionSealer(sessionChainStore, transcriptWriter);

    const firstService = {
      async *invoke() {
        yield {
          type: 'session_init',
          catId,
          sessionId: 'cascade-old-transcript',
          sessionLifecycle: {
            runtime: 'antigravity-desktop',
            runtimeSessionId: 'cascade-old-transcript',
          },
          metadata: { provider: 'antigravity', model: 'claude-opus-4-6', modelVerified: true },
          timestamp: Date.now(),
        };
        yield {
          type: 'text',
          catId,
          content: 'I inspected the old cascade and will edit the file.',
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_use',
          catId,
          toolName: 'Edit',
          toolInput: { file_path: '/repo/src/app.ts' },
          timestamp: Date.now(),
        };
        yield {
          type: 'tool_result',
          catId,
          content: 'Edited /repo/src/app.ts successfully.',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    };
    const deps = makeDeps({ sessionChainStore, sessionSealer, runtimeSessionStore, transcriptWriter });

    await collect(
      invokeSingleCat(deps, {
        catId,
        service: firstService,
        prompt: 'first cascade',
        userId: 'user-f211-transcript',
        threadId,
        isLastCat: true,
      }),
    );

    const oldSession = sessionChainStore.getActive(catId, threadId);
    assert.ok(oldSession, 'first Antigravity session must create an active SessionRecord');

    const rotationService = {
      async *invoke() {
        yield {
          type: 'session_init',
          catId,
          sessionId: 'cascade-new-transcript',
          sessionLifecycle: {
            runtime: 'antigravity-desktop',
            runtimeSessionId: 'cascade-new-transcript',
            previousRuntimeSessionId: 'cascade-old-transcript',
            sealReason: 'model_capacity',
            drainResult: 'complete',
          },
          metadata: { provider: 'antigravity', model: 'claude-opus-4-6', modelVerified: true },
          timestamp: Date.now(),
        };
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(deps, {
        catId,
        service: rotationService,
        prompt: 'rotate cascade',
        userId: 'user-f211-transcript',
        threadId,
        isLastCat: true,
      }),
    );

    const digest = await waitForDigest(transcriptReader, oldSession.id, threadId, catId);
    assert.ok(digest, 'old session should be finalized with an extractive digest');

    const eventResult = await transcriptReader.readEvents(oldSession.id, threadId, catId);
    const eventTypes = eventResult.events.map((entry) => entry.event.type);
    assert.ok(eventTypes.includes('text'), 'old transcript should include visible assistant text');
    assert.ok(eventTypes.includes('tool_use'), 'old transcript should include tool_use evidence');
    assert.ok(eventTypes.includes('tool_result'), 'old transcript should include tool_result evidence');
    assert.ok(
      eventResult.events.some(
        (entry) =>
          entry.event.type === 'system_info' &&
          typeof entry.event.content === 'string' &&
          entry.event.content.includes('antigravity_runtime_lifecycle') &&
          entry.event.content.includes('model_capacity'),
      ),
      'old transcript should include the Antigravity lifecycle seal boundary',
    );
    assert.ok(
      digest.recentMessages?.some((msg) => msg.content.includes('I inspected the old cascade')),
      'digest should retain non-empty recent assistant text',
    );
    assert.equal(digest.sealReason, 'model_capacity');
  });
});
