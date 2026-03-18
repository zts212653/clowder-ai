import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StreamingTtsChunker } from '../dist/domains/cats/services/tts/StreamingTtsChunker.js';

function createMockTtsRegistry() {
  const synthesized = [];
  return {
    synthesized,
    getDefault() {
      return {
        id: 'mock',
        model: 'mock-model',
        async synthesize(request) {
          synthesized.push(request.text);
          const audioBytes = new TextEncoder().encode(`audio:${request.text}`);
          return {
            audio: audioBytes,
            format: 'wav',
            durationSec: 1.0,
            metadata: { provider: 'mock', model: 'mock', voice: 'test' },
          };
        },
      };
    },
  };
}

function createMockBroadcaster() {
  const events = [];
  return {
    events,
    broadcastToRoom(room, event, data) {
      events.push({ room, event, data });
    },
  };
}

const baseConfig = {
  catId: 'opus',
  invocationId: 'inv-001',
  threadId: 'thread-001',
  voiceConfig: { voice: 'test-voice', langCode: 'zh', speed: 1.0 },
};

describe('StreamingTtsChunker', () => {
  it('splits tokens into sentences and synthesizes each', async () => {
    const registry = createMockTtsRegistry();
    const broadcaster = createMockBroadcaster();
    const chunker = new StreamingTtsChunker({
      ...baseConfig,
      broadcaster,
      ttsRegistry: registry,
    });

    for (const ch of '你好世界。再见。') {
      chunker.feed(ch);
    }

    const totalChunks = await chunker.flush();
    assert.equal(totalChunks, 2);
    assert.deepEqual(registry.synthesized, ['你好世界。', '再见。']);

    // voice_stream_start is emitted before first chunk
    const startEvents = broadcaster.events.filter((e) => e.event === 'voice_stream_start');
    const chunkEvents = broadcaster.events.filter((e) => e.event === 'voice_chunk');
    assert.equal(startEvents.length, 1);
    assert.equal(chunkEvents.length, 2);
    assert.equal(chunkEvents[0].data.index, 0);
    assert.equal(chunkEvents[0].data.text, '你好世界。');
    assert.equal(chunkEvents[1].data.index, 1);
    assert.equal(chunkEvents[0].room, 'thread:thread-001');
  });

  it('handles newlines as hard breaks', async () => {
    const registry = createMockTtsRegistry();
    const broadcaster = createMockBroadcaster();
    const chunker = new StreamingTtsChunker({
      ...baseConfig,
      broadcaster,
      ttsRegistry: registry,
    });

    chunker.feed('第一行\n第二行');
    const totalChunks = await chunker.flush();
    assert.equal(totalChunks, 2);
    assert.deepEqual(registry.synthesized, ['第一行', '第二行']);
  });

  it('flushes remaining buffer on flush()', async () => {
    const registry = createMockTtsRegistry();
    const broadcaster = createMockBroadcaster();
    const chunker = new StreamingTtsChunker({
      ...baseConfig,
      broadcaster,
      ttsRegistry: registry,
    });

    chunker.feed('没有标点的一段话');
    const totalChunks = await chunker.flush();
    assert.equal(totalChunks, 1);
    assert.deepEqual(registry.synthesized, ['没有标点的一段话']);
  });

  it('does not synthesize empty buffer', async () => {
    const registry = createMockTtsRegistry();
    const broadcaster = createMockBroadcaster();
    const chunker = new StreamingTtsChunker({
      ...baseConfig,
      broadcaster,
      ttsRegistry: registry,
    });

    chunker.feed('');
    const totalChunks = await chunker.flush();
    assert.equal(totalChunks, 0);
    assert.equal(registry.synthesized.length, 0);
  });

  it('stops synthesizing after abort', async () => {
    const registry = createMockTtsRegistry();
    const broadcaster = createMockBroadcaster();
    const controller = new AbortController();
    const chunker = new StreamingTtsChunker({
      ...baseConfig,
      broadcaster,
      ttsRegistry: registry,
      signal: controller.signal,
    });

    chunker.feed('第一句。');
    controller.abort();
    chunker.feed('第二句。');
    const totalChunks = await chunker.flush();
    assert.ok(totalChunks <= 1);
  });

  it('includes voice config fields in synthesis request', async () => {
    const registry = createMockTtsRegistry();
    const broadcaster = createMockBroadcaster();

    let capturedRequest = null;
    registry.getDefault = () => ({
      id: 'mock',
      model: 'mock',
      async synthesize(req) {
        capturedRequest = req;
        return {
          audio: new Uint8Array(1),
          format: 'wav',
          durationSec: 0.5,
          metadata: { provider: 'mock', model: 'mock', voice: 'test' },
        };
      },
    });

    const chunker = new StreamingTtsChunker({
      ...baseConfig,
      voiceConfig: {
        voice: 'custom',
        langCode: 'en',
        speed: 1.5,
        refAudio: '/ref.wav',
        refText: 'hello',
        instruct: 'be happy',
        temperature: 0.5,
      },
      broadcaster,
      ttsRegistry: registry,
    });

    chunker.feed('Hello!');
    await chunker.flush();

    assert.equal(capturedRequest.voice, 'custom');
    assert.equal(capturedRequest.langCode, 'en');
    assert.equal(capturedRequest.speed, 1.5);
    assert.equal(capturedRequest.refAudio, '/ref.wav');
    assert.equal(capturedRequest.refText, 'hello');
    assert.equal(capturedRequest.instruct, 'be happy');
    assert.equal(capturedRequest.temperature, 0.5);
  });

  it('broadcasts correct event shape', async () => {
    const registry = createMockTtsRegistry();
    const broadcaster = createMockBroadcaster();
    const chunker = new StreamingTtsChunker({
      ...baseConfig,
      broadcaster,
      ttsRegistry: registry,
    });

    chunker.feed('测试。');
    await chunker.flush();

    const chunkEvents = broadcaster.events.filter((e) => e.event === 'voice_chunk');
    const event = chunkEvents[0].data;
    assert.equal(event.type, 'voice_chunk');
    assert.equal(event.catId, 'opus');
    assert.equal(event.invocationId, 'inv-001');
    assert.equal(event.threadId, 'thread-001');
    assert.equal(event.index, 0);
    assert.equal(event.format, 'wav');
    assert.equal(typeof event.audioBase64, 'string');
    assert.equal(typeof event.durationSec, 'number');
  });

  it('handles soft breaks with boost threshold', async () => {
    const registry = createMockTtsRegistry();
    const broadcaster = createMockBroadcaster();
    const chunker = new StreamingTtsChunker({
      ...baseConfig,
      broadcaster,
      ttsRegistry: registry,
    });

    chunker.feed('嗨，你好');
    await chunker.flush();
    assert.equal(registry.synthesized.length, 2);
    assert.equal(registry.synthesized[0], '嗨，');
    assert.equal(registry.synthesized[1], '你好');
  });

  it('emits voice_stream_start before first chunk and sets hasStarted', async () => {
    const registry = createMockTtsRegistry();
    const broadcaster = createMockBroadcaster();
    const chunker = new StreamingTtsChunker({
      ...baseConfig,
      broadcaster,
      ttsRegistry: registry,
    });

    assert.equal(chunker.hasStarted(), false);
    chunker.feed('你好。');
    await chunker.flush();

    assert.equal(chunker.hasStarted(), true);
    assert.equal(broadcaster.events[0].event, 'voice_stream_start');
    assert.equal(broadcaster.events[0].data.catId, 'opus');
    assert.equal(broadcaster.events[0].data.invocationId, 'inv-001');
    assert.equal(broadcaster.events[0].data.threadId, 'thread-001');
    assert.equal(broadcaster.events[1].event, 'voice_chunk');
  });

  it('does not emit voice_stream_start when no text is synthesized', async () => {
    const registry = createMockTtsRegistry();
    const broadcaster = createMockBroadcaster();
    const chunker = new StreamingTtsChunker({
      ...baseConfig,
      broadcaster,
      ttsRegistry: registry,
    });

    chunker.feed('');
    await chunker.flush();
    assert.equal(chunker.hasStarted(), false);
    assert.equal(broadcaster.events.length, 0);
  });
});
