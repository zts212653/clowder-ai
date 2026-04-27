/**
 * F34: MlxAudioTtsProvider tests
 * Mocks global fetch to test HTTP interaction with Python TTS server.
 */

import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { calculateTimeout, MlxAudioTtsProvider } from '../dist/domains/cats/services/tts/MlxAudioTtsProvider.js';

describe('MlxAudioTtsProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('has correct id and model', () => {
    const p = new MlxAudioTtsProvider({ baseUrl: 'http://localhost:9999' });
    assert.strictEqual(p.id, 'mlx-audio');
    assert.strictEqual(p.model, 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16');
  });

  it('sends correct request body to TTS server', async () => {
    let capturedUrl;
    let capturedBody;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };

    const p = new MlxAudioTtsProvider({ baseUrl: 'http://test:9877' });
    await p.synthesize({ text: 'hello', voice: 'vm_test', langCode: 'en', speed: 1.5, format: 'wav' });

    assert.strictEqual(capturedUrl, 'http://test:9877/v1/audio/speech');
    assert.strictEqual(capturedBody.input, 'hello');
    assert.strictEqual(capturedBody.voice, 'vm_test');
    assert.strictEqual(capturedBody.response_format, 'wav');
    assert.strictEqual(capturedBody.speed, 1.5);
    assert.strictEqual(capturedBody.lang_code, 'en');
  });

  it('returns Uint8Array audio with correct metadata', async () => {
    const audioBytes = new Uint8Array([0, 1, 2, 3, 4]);
    globalThis.fetch = async () => new Response(audioBytes, { status: 200 });

    const p = new MlxAudioTtsProvider({ baseUrl: 'http://test:9877' });
    const result = await p.synthesize({ text: 'test', voice: 'v1' });

    assert.ok(result.audio instanceof Uint8Array);
    assert.strictEqual(result.audio.length, 5);
    assert.strictEqual(result.format, 'wav');
    assert.strictEqual(result.metadata.provider, 'mlx-audio');
    assert.strictEqual(result.metadata.voice, 'v1');
  });

  it('throws on non-200 response', async () => {
    globalThis.fetch = async () => new Response('Internal Server Error', { status: 500 });

    const p = new MlxAudioTtsProvider({ baseUrl: 'http://test:9877' });
    await assert.rejects(
      () => p.synthesize({ text: 'test', voice: 'v1' }),
      (err) => err.message.includes('500'),
    );
  });

  it('uses default langCode and speed when not provided', async () => {
    let capturedBody;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(new Uint8Array(0), { status: 200 });
    };

    const p = new MlxAudioTtsProvider({ baseUrl: 'http://test:9877' });
    await p.synthesize({ text: 'test', voice: 'v1' });

    assert.strictEqual(capturedBody.speed, 1.0);
    assert.strictEqual(capturedBody.lang_code, 'z');
    assert.strictEqual(capturedBody.response_format, 'wav');
  });

  // F066: Format contract tests — edge-tts returns mp3 when wav was requested
  it('respects x-audio-format header from server (edge-tts mp3 case)', async () => {
    const mp3Bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]); // fake mp3 header
    globalThis.fetch = async () =>
      new Response(mp3Bytes, {
        status: 200,
        headers: { 'x-audio-format': 'mp3' },
      });

    const p = new MlxAudioTtsProvider({ baseUrl: 'http://test:9877' });
    const result = await p.synthesize({ text: 'test', voice: 'v1', format: 'wav' });

    // Provider must report the actual format from server, not the requested format
    assert.strictEqual(result.format, 'mp3', 'format should match server x-audio-format header');
    assert.ok(result.audio instanceof Uint8Array);
    assert.strictEqual(result.audio.length, 4);
  });

  it('falls back to requested format when x-audio-format header is absent', async () => {
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2]), { status: 200 });

    const p = new MlxAudioTtsProvider({ baseUrl: 'http://test:9877' });
    const result = await p.synthesize({ text: 'test', voice: 'v1', format: 'wav' });

    assert.strictEqual(result.format, 'wav', 'format should fall back to requested format');
  });

  // F066-R2: Security — malicious x-audio-format header must be rejected
  it('rejects malicious x-audio-format header (path traversal prevention)', async () => {
    globalThis.fetch = async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'x-audio-format': '../../../../etc/passwd' },
      });

    const p = new MlxAudioTtsProvider({ baseUrl: 'http://test:9877' });
    const result = await p.synthesize({ text: 'test', voice: 'v1', format: 'wav' });

    // Must fall back to requested format, NOT use the malicious value
    assert.strictEqual(result.format, 'wav', 'malicious header must be rejected');
  });

  it('rejects unknown x-audio-format values', async () => {
    globalThis.fetch = async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'x-audio-format': 'ogg' },
      });

    const p = new MlxAudioTtsProvider({ baseUrl: 'http://test:9877' });
    const result = await p.synthesize({ text: 'test', voice: 'v1', format: 'wav' });

    assert.strictEqual(result.format, 'wav', 'unknown format must fall back to requested');
  });

  // F066: Clone param passthrough tests
  it('sends clone params (refAudio, refText, instruct, temperature) to TTS server', async () => {
    let capturedBody;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(new Uint8Array([1]), { status: 200 });
    };

    const p = new MlxAudioTtsProvider({ baseUrl: 'http://test:9877' });
    await p.synthesize({
      text: '你好',
      voice: 'wanderer',
      langCode: 'zh',
      refAudio: '/path/to/ref.wav',
      refText: '参考文本',
      instruct: '用调皮的语气说话',
      temperature: 0.3,
    });

    assert.strictEqual(capturedBody.ref_audio, '/path/to/ref.wav');
    assert.strictEqual(capturedBody.ref_text, '参考文本');
    assert.strictEqual(capturedBody.instruct, '用调皮的语气说话');
    assert.strictEqual(capturedBody.temperature, 0.3);
  });

  it('omits clone params from body when not provided', async () => {
    let capturedBody;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(new Uint8Array([1]), { status: 200 });
    };

    const p = new MlxAudioTtsProvider({ baseUrl: 'http://test:9877' });
    await p.synthesize({ text: 'test', voice: 'v1' });

    assert.strictEqual(capturedBody.ref_audio, undefined, 'ref_audio should be absent');
    assert.strictEqual(capturedBody.ref_text, undefined, 'ref_text should be absent');
    assert.strictEqual(capturedBody.instruct, undefined, 'instruct should be absent');
    // temperature is not sent when not provided
    assert.strictEqual(capturedBody.temperature, undefined, 'temperature should be absent');
  });
});

describe('calculateTimeout', () => {
  // ── Clone mode (60s warmup absorbs refAudio load) ───────────
  it('short clone text gets generation + 60s warmup', () => {
    // 50 chars * 3 = 150 tokens / 15 tps = 10s + 60s warmup = 70s
    assert.strictEqual(calculateTimeout('a'.repeat(50), true, 30_000), 70_000);
  });

  it('long clone text scales linearly', () => {
    // 500 chars * 3 = 1500 tokens / 15 tps = 100s + 60s warmup = 160s
    assert.strictEqual(calculateTimeout('a'.repeat(500), true, 30_000), 160_000);
  });

  it('410-char clone (regression case from 2026-04-27) gets 142s — comfortably above prior 120s', () => {
    // 410 * 3 = 1230 tokens / 15 tps = 82s + 60s warmup = 142s
    // Prior fixed cap was 120s; bumped to 142s after cloud codex round 3 P1
    // pointed out 30s warmup was too tight (gave 112s, less than prior guard).
    assert.strictEqual(calculateTimeout('a'.repeat(410), true, 30_000), 142_000);
  });

  it('clone honors high caller baseTimeoutMs (P2 round 1: slow/cold-start hosts)', () => {
    // 50 chars * 3 / 15 = 10s + 60s = 70s; caller wants 180s, max wins
    assert.strictEqual(calculateTimeout('a'.repeat(50), true, 180_000), 180_000);
  });

  it('caller baseTimeoutMs ABOVE hard cap is honored, not clamped (P2 round 2)', () => {
    // Caller passes 1_200_000 ms (20 min) for a very slow host. Old
    // `Math.min(..., 600_000)` would have clamped to 10 min. Hard cap now
    // bounds only the dynamic estimate.
    assert.strictEqual(calculateTimeout('a'.repeat(50), true, 1_200_000), 1_200_000);
  });

  // ── Non-clone (5s warmup, fast-fail preserved) ───────────────
  it('non-clone short text PRESERVES baseTimeoutMs fast-fail (P1-1 regression guard)', () => {
    // 10 chars * 3 / 25 = 1.2s + 5s = 6.2s; baseTimeoutMs 30s floor wins.
    // Pre-fix bug had this as 61.2s when warmup was a single 60s for both modes.
    assert.strictEqual(calculateTimeout('a'.repeat(10), false, 30_000), 30_000);
  });

  it('non-clone empty text uses baseTimeoutMs floor', () => {
    assert.strictEqual(calculateTimeout('', false, 90_000), 90_000);
  });

  it('non-clone long text scales past floor', () => {
    // 1000 chars * 3 / 25 = 120s + 5s = 125s
    assert.strictEqual(calculateTimeout('a'.repeat(1000), false, 30_000), 125_000);
  });

  // ── P1-2 fix: hard cap on dynamic estimate ───────────────────
  it('5000-char clone with default base is clamped to 600s hard cap', () => {
    // 5000 * 3 / 15 = 1000s + 60s = 1060s, capped to 600s; base 30s loses.
    // Prevents runaway timeout × VoiceBlockSynthesizer retry → 35min lockup.
    assert.strictEqual(calculateTimeout('a'.repeat(5000), true, 30_000), 600_000);
  });

  it('10000-char non-clone with default base is clamped to 600s hard cap', () => {
    // 10000 * 3 / 25 = 1200s + 5s = 1205s, capped to 600s.
    assert.strictEqual(calculateTimeout('a'.repeat(10_000), false, 30_000), 600_000);
  });

  // ── Boundary ─────────────────────────────────────────────────
  it('clone just under hard-cap threshold stays dynamic', () => {
    // 2700 chars * 3 / 15 = 540s + 60s = 600s — exactly at cap, capped to 600s.
    // 2690 chars: 538 * 1000 = 538s + 60s = 598s, just under cap.
    assert.strictEqual(calculateTimeout('a'.repeat(2690), true, 30_000), 598_000);
  });
});
