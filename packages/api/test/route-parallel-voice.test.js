/**
 * F34-b: routeParallel voice synthesis regression tests
 *
 * Verifies that text-only audio blocks in cc_rich are resolved via
 * VoiceBlockSynthesizer before being persisted — the exact path that
 * cloud Codex flagged as P1 (route-parallel had no synthesis).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock agent service that yields cc_rich text containing an audio block */
function createVoiceService(catId, richJson) {
  const text = `Here is my voice:\n\`\`\`cc_rich\n${richJson}\n\`\`\``;
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendCalls) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: () => null,
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        if (appendCalls) appendCalls.push(msg);
        return { id: `msg-${counter}`, userId: '', catId: null, content: '', mentions: [], timestamp: 0 };
      },
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

// ---------------------------------------------------------------------------
// Setup: init VoiceBlockSynthesizer singleton with mock TTS provider
// ---------------------------------------------------------------------------

const tmpDir = path.join(os.tmpdir(), 'cat-cafe-rp-voice-test');

before(async () => {
  // Clean stale cache
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ok */
  }

  const { initVoiceBlockSynthesizer } = await import('../dist/domains/cats/services/tts/VoiceBlockSynthesizer.js');

  const mockRegistry = {
    getDefault: () => ({
      id: 'mock',
      model: 'test',
      synthesize: async () => ({
        audio: Buffer.from('fake-audio-data'),
        format: 'wav',
        metadata: { provider: 'mock', model: 'test', voice: 'test' },
      }),
    }),
  };

  initVoiceBlockSynthesizer(mockRegistry, tmpDir);
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ok */
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routeParallel voice synthesis (F34-b regression)', () => {
  it('synthesizes text-only audio block in cc_rich to playable url', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const richPayload = JSON.stringify({
      v: 1,
      blocks: [{ id: 'a1', kind: 'audio', v: 1, text: 'Hello from parallel mode' }],
    });

    const appendCalls = [];
    const deps = createMockDeps({ opus: createVoiceService('opus', richPayload) }, appendCalls);

    for await (const _msg of routeParallel(deps, ['opus'], 'say hello', 'user1', 'thread1')) {
      // drain
    }

    assert.equal(appendCalls.length, 1, 'should persist one message');
    const stored = appendCalls[0];
    assert.ok(stored.extra?.rich?.blocks, 'stored message should have rich blocks');
    assert.equal(stored.extra.rich.blocks.length, 1);

    const audioBlock = stored.extra.rich.blocks[0];
    assert.equal(audioBlock.kind, 'audio');
    assert.ok(
      audioBlock.url?.startsWith('/api/tts/audio/'),
      `audio block should have synthesized url, got: ${audioBlock.url}`,
    );
    assert.equal(audioBlock.text, 'Hello from parallel mode');
    assert.equal(audioBlock.mimeType, 'audio/wav');
  });

  it('does NOT re-synthesize audio block that already has url', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const richPayload = JSON.stringify({
      v: 1,
      blocks: [
        {
          id: 'a2',
          kind: 'audio',
          v: 1,
          url: '/api/tts/audio/existing.wav',
          text: 'Already synthesized',
        },
      ],
    });

    const appendCalls = [];
    const deps = createMockDeps({ opus: createVoiceService('opus', richPayload) }, appendCalls);

    for await (const _msg of routeParallel(deps, ['opus'], 'say again', 'user1', 'thread1')) {
      // drain
    }

    assert.equal(appendCalls.length, 1);
    const audioBlock = appendCalls[0].extra?.rich?.blocks?.[0];
    assert.equal(audioBlock.kind, 'audio');
    assert.equal(audioBlock.url, '/api/tts/audio/existing.wav', 'should preserve original url');
  });
});
