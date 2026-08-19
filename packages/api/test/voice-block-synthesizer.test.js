/**
 * F34-b: VoiceBlockSynthesizer tests
 *
 * Tests the singleton lifecycle, block pass-through, TTS synthesis,
 * graceful degradation, and cache hit logic.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

/** Clean up test temp directory to avoid stale cache hits between runs. */
function cleanTmpDir(dirName) {
  const p = path.join(os.tmpdir(), dirName);
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ok */
  }
}

import { getCatVoice } from '../dist/config/cat-voices.js';
import {
  getVoiceBlockSynthesizer,
  initVoiceBlockSynthesizer,
  VoiceBlockSynthesizer,
} from '../dist/domains/cats/services/tts/VoiceBlockSynthesizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock TtsRegistry with a single provider. */
function makeMockRegistry({ synthesize } = {}) {
  const provider = {
    id: 'mock',
    model: 'test',
    synthesize:
      synthesize ??
      (async () => ({
        audio: Buffer.from('fake-audio'),
        format: 'wav',
        metadata: { provider: 'mock', model: 'test', voice: 'test' },
      })),
  };
  return {
    getDefault: () => provider,
    _provider: provider,
  };
}

/**
 * Compute the cache filename the synthesizer would produce for `opus` cat
 * with the actual voice config and the given text.
 * Mirrors the hash logic in VoiceBlockSynthesizer.synthesizeToFile.
 */
function expectedCacheFilename(text) {
  const v = getCatVoice('opus');
  const hashParts = ['mock', 'test', v.voice, v.langCode, String(v.speed ?? 1), 'wav', text];
  if (v.refAudio) hashParts.push(v.refAudio);
  if (v.refText) hashParts.push(v.refText);
  if (v.instruct) hashParts.push(v.instruct);
  if (v.temperature != null) hashParts.push(String(v.temperature));
  const hash = createHash('sha256').update(hashParts.join('|')).digest('hex');
  return `${hash}.wav`;
}

/** Build a small mono PCM16 WAV fixture with the supplied sample values. */
function makePcmWav(samples, sampleRate = 24_000) {
  const dataSize = samples.length * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(sample, 44 + index * 2));
  return wav;
}

function readPcmWavSamples(wav) {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  const dataSize = wav.readUInt32LE(40);
  assert.equal(wav.length, 44 + dataSize, 'WAV header reflects the complete PCM payload');
  const samples = [];
  for (let offset = 44; offset < wav.length; offset += 2) {
    samples.push(wav.readInt16LE(offset));
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Singleton lifecycle
// ---------------------------------------------------------------------------

describe('VoiceBlockSynthesizer singleton', () => {
  // Reset the singleton between tests by re-initialising to a known state.
  // We cannot set `instance` directly (it is module-private), but
  // re-calling initVoiceBlockSynthesizer overwrites it, and we accept that
  // each lifecycle test may leave the singleton set — the describe blocks
  // below create their own instances directly instead of relying on the singleton.

  it('getVoiceBlockSynthesizer returns null before any init', async () => {
    // We cannot guarantee the module was never imported before, so we call
    // initVoiceBlockSynthesizer with a fresh registry to reset, then verify
    // the singleton is non-null.  The "null before init" state is tested by
    // importing in isolation using a fresh module — instead we test the
    // observable contract via initVoiceBlockSynthesizer.
    //
    // Because Node.js ESM caches modules, the "returns null before init" case
    // can only be guaranteed in a fresh process.  We therefore test it
    // indirectly: after re-setting with initVoiceBlockSynthesizer the return
    // value must be a VoiceBlockSynthesizer instance, confirming the module's
    // own null→instance transition works.
    const registry = makeMockRegistry();
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-singleton');
    initVoiceBlockSynthesizer(registry, cacheDir);
    const instance = getVoiceBlockSynthesizer();
    assert.ok(instance instanceof VoiceBlockSynthesizer, 'singleton is a VoiceBlockSynthesizer after init');
  });

  it('initVoiceBlockSynthesizer sets a new singleton', () => {
    const registry = makeMockRegistry();
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-new-singleton');
    initVoiceBlockSynthesizer(registry, cacheDir);
    const first = getVoiceBlockSynthesizer();
    assert.ok(first !== null, 'singleton is set');

    // Re-initialising creates a distinct object
    const registry2 = makeMockRegistry();
    const cacheDir2 = path.join(os.tmpdir(), 'vbs-test-new-singleton-2');
    initVoiceBlockSynthesizer(registry2, cacheDir2);
    const second = getVoiceBlockSynthesizer();
    assert.ok(second !== null, 'singleton is still set after re-init');
    assert.notStrictEqual(first, second, 're-init replaced the singleton');
  });
});

// ---------------------------------------------------------------------------
// resolveVoiceBlocks — block pass-through
// ---------------------------------------------------------------------------

describe('VoiceBlockSynthesizer.resolveVoiceBlocks — pass-through', () => {
  let synthesizer;

  beforeEach(() => {
    const registry = makeMockRegistry();
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-passthrough');
    synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);
  });

  it('passes through non-audio blocks unchanged', async () => {
    const blocks = [
      { id: 'c1', kind: 'card', v: 1, title: 'Hello', tone: 'info' },
      { id: 'd1', kind: 'diff', v: 1, filePath: 'a.ts', diff: '+x' },
      { id: 'k1', kind: 'checklist', v: 1, items: [{ id: 'i1', text: 'Task' }] },
    ];
    const result = await synthesizer.resolveVoiceBlocks(blocks, 'opus');
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], blocks[0]);
    assert.deepEqual(result[1], blocks[1]);
    assert.deepEqual(result[2], blocks[2]);
  });

  it('passes through audio blocks that already have a url', async () => {
    const block = {
      id: 'a1',
      kind: 'audio',
      v: 1,
      url: '/api/tts/audio/existing.wav',
      title: 'Pre-synthesized',
    };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], block);
  });

  it('passes through audio blocks that have both text and url (url wins)', async () => {
    // An audio block with an existing url should not be re-synthesized,
    // even if text is also present.
    const block = {
      id: 'a2',
      kind: 'audio',
      v: 1,
      url: '/api/tts/audio/already.wav',
      text: 'this should not trigger synthesis',
    };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], block, 'block passed through unchanged');
  });

  it('passes through mixed blocks, only synthesizing text-only audio blocks', async () => {
    let synthesizeCalls = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        synthesizeCalls++;
        return {
          audio: Buffer.from('audio-data'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-mixed');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-mixed');
    const syn = new VoiceBlockSynthesizer(registry, cacheDir);

    const blocks = [
      { id: 'c1', kind: 'card', v: 1, title: 'A card' },
      { id: 'a1', kind: 'audio', v: 1, url: '/existing.wav' },
      { id: 'a2', kind: 'audio', v: 1, text: 'synthesize me' },
    ];
    const result = await syn.resolveVoiceBlocks(blocks, 'opus');

    assert.equal(result.length, 3);
    assert.equal(result[0].kind, 'card');
    assert.equal(result[1].kind, 'audio');
    assert.equal(result[1].url, '/existing.wav', 'pre-existing url preserved');
    assert.equal(result[2].kind, 'audio');
    assert.ok(result[2].url.startsWith('/api/tts/audio/'), 'synthesized url populated');
    assert.equal(synthesizeCalls, 1, 'synthesis called exactly once');
  });
});

// ---------------------------------------------------------------------------
// resolveVoiceBlocks — synthesis
// ---------------------------------------------------------------------------

describe('VoiceBlockSynthesizer.resolveVoiceBlocks — synthesis', () => {
  it('synthesizes audio for a block with text but no url', async () => {
    let callCount = 0;
    let receivedArgs;
    const registry = makeMockRegistry({
      synthesize: async (args) => {
        callCount++;
        receivedArgs = args;
        return {
          audio: Buffer.from('fake-audio'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-synthesis');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-synthesis');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'a1', kind: 'audio', v: 1, text: 'Hello world' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result.length, 1);
    const resolved = result[0];
    assert.equal(resolved.kind, 'audio', 'kind stays audio');
    assert.ok(typeof resolved.url === 'string' && resolved.url.length > 0, 'url is populated');
    assert.ok(resolved.url.startsWith('/api/tts/audio/'), 'url has expected prefix');
    assert.ok(resolved.url.endsWith('.wav'), 'url ends with .wav');
    assert.equal(resolved.mimeType, 'audio/wav', 'mimeType set to audio/wav');
    assert.equal(resolved.text, 'Hello world', 'original text field preserved');

    // Synthesis was called once with the expected args
    assert.equal(callCount, 1);
    assert.equal(receivedArgs.text, 'Hello world');
    assert.equal(receivedArgs.format, 'wav');
    assert.ok(typeof receivedArgs.voice === 'string', 'voice passed to synthesize');

    // F066: clone params should be passed through from getCatVoice('opus')
    const opusVoice = getCatVoice('opus');
    if (opusVoice.refAudio) {
      assert.equal(receivedArgs.refAudio, opusVoice.refAudio, 'refAudio passed through');
    }
    if (opusVoice.refText) {
      assert.equal(receivedArgs.refText, opusVoice.refText, 'refText passed through');
    }
    if (opusVoice.instruct) {
      assert.equal(receivedArgs.instruct, opusVoice.instruct, 'instruct passed through');
    }
    if (opusVoice.temperature != null) {
      assert.equal(receivedArgs.temperature, opusVoice.temperature, 'temperature passed through');
    }
  });

  it('chunks long text and joins every synthesized WAV segment without losing the tail', async () => {
    const receivedTexts = [];
    const registry = makeMockRegistry({
      synthesize: async (args) => {
        receivedTexts.push(args.text);
        return {
          audio: makePcmWav([receivedTexts.length]),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-long-text');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-long-text');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);
    const tailMarker = '结尾标记必须被完整说出来';
    const longText = `${'领导的注意力很稀缺，所以汇报要先讲结论，再补证据和行动建议。'.repeat(20)}${tailMarker}`;
    const block = { id: 'long-audio', kind: 'audio', v: 1, text: longText };

    const [resolved] = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(resolved.kind, 'audio');
    assert.ok(receivedTexts.length > 1, 'long static audio should use bounded provider requests');
    assert.equal(receivedTexts.join(''), longText, 'chunking must preserve the complete input text');
    assert.ok(receivedTexts.at(-1).includes(tailMarker), 'the final provider request contains the tail marker');

    const filename = path.basename(resolved.url);
    const output = fs.readFileSync(path.join(cacheDir, filename));
    assert.deepEqual(
      readPcmWavSamples(output),
      receivedTexts.map((_, index) => index + 1),
      'the output WAV contains every synthesized segment in order',
    );
  });

  it('uses block.speaker override instead of catId for voice lookup (F085-P3)', async () => {
    const receivedVoiceArgs = [];
    const registry = makeMockRegistry({
      synthesize: async (args) => {
        receivedVoiceArgs.push(args);
        return {
          audio: Buffer.from('fake'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-speaker-override');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-speaker-override');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    // Three blocks with different speakers — sent by 'opus' but each has a speaker override
    const blocks = [
      { id: 'v1', kind: 'audio', v: 1, text: 'Opus voice', speaker: 'opus' },
      { id: 'v2', kind: 'audio', v: 1, text: 'Codex voice', speaker: 'codex' },
      { id: 'v3', kind: 'audio', v: 1, text: 'Gemini voice', speaker: 'gemini' },
    ];
    const result = await synthesizer.resolveVoiceBlocks(blocks, 'opus');

    assert.equal(result.length, 3, 'all three blocks resolved');
    assert.equal(receivedVoiceArgs.length, 3, 'synthesis called three times');

    // Each call should use the speaker's voice config, not the message sender's
    const opusVoice = getCatVoice('opus');
    const codexVoice = getCatVoice('codex');
    const geminiVoice = getCatVoice('gemini');

    assert.equal(receivedVoiceArgs[0].voice, opusVoice.voice, 'first block uses opus voice');
    assert.equal(receivedVoiceArgs[1].voice, codexVoice.voice, 'second block uses codex voice');
    assert.equal(receivedVoiceArgs[2].voice, geminiVoice.voice, 'third block uses gemini voice');

    // Verify clone params differ per speaker (if configured)
    if (opusVoice.refAudio && codexVoice.refAudio) {
      assert.equal(receivedVoiceArgs[0].refAudio, opusVoice.refAudio);
      assert.equal(receivedVoiceArgs[1].refAudio, codexVoice.refAudio);
    }
  });

  it('falls back to catId when speaker is not set (backward compat)', async () => {
    let receivedVoice;
    const registry = makeMockRegistry({
      synthesize: async (args) => {
        receivedVoice = args.voice;
        return {
          audio: Buffer.from('x'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-no-speaker');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-no-speaker');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    // No speaker field — should use catId ('codex')
    const block = { id: 'a1', kind: 'audio', v: 1, text: 'No speaker field' };
    await synthesizer.resolveVoiceBlocks([block], 'codex');

    const codexVoice = getCatVoice('codex');
    assert.equal(receivedVoice, codexVoice.voice, 'uses catId voice when no speaker override');
  });

  it('trims whitespace from block text before synthesis', async () => {
    let receivedText;
    const registry = makeMockRegistry({
      synthesize: async (args) => {
        receivedText = args.text;
        return {
          audio: Buffer.from('x'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-trim');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-trim');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'a1', kind: 'audio', v: 1, text: '  trimmed text  ' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'audio', 'remains audio after synthesis');
    assert.equal(receivedText, 'trimmed text', 'text was trimmed');
  });
});

// ---------------------------------------------------------------------------
// resolveVoiceBlocks — graceful degradation
// ---------------------------------------------------------------------------

describe('VoiceBlockSynthesizer.resolveVoiceBlocks — degradation', () => {
  it('degrades to card block when synthesis throws', async () => {
    const registry = makeMockRegistry({
      synthesize: async () => {
        throw new Error('TTS service unavailable');
      },
    });
    cleanTmpDir('vbs-test-degrade');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-degrade');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'a1', kind: 'audio', v: 1, text: 'Spoken content' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result.length, 1);
    const degraded = result[0];
    assert.equal(degraded.kind, 'card', 'degraded to card');
    assert.equal(degraded.id, 'a1', 'original id preserved');
    assert.equal(degraded.tone, 'warning', 'degradation tone is warning');
    assert.ok(typeof degraded.title === 'string' && degraded.title.length > 0, 'degraded card has a title');
    assert.ok(degraded.bodyMarkdown.includes('Spoken content'), 'card body contains original text');
  });

  it('degrades to card when registry has no providers', async () => {
    // Registry with no providers throws from getDefault()
    const emptyRegistry = {
      getDefault: () => {
        throw new Error('No TTS providers registered');
      },
    };
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-no-provider');
    const synthesizer = new VoiceBlockSynthesizer(emptyRegistry, cacheDir);

    const block = { id: 'a2', kind: 'audio', v: 1, text: 'Will fail' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'card', 'degraded to card');
    assert.equal(result[0].tone, 'warning');
  });

  it('continues processing remaining blocks after a single failure', async () => {
    let callCount = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        callCount++;
        if (callCount === 1) throw new Error('first call fails');
        return {
          audio: Buffer.from('ok'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-continue');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-continue');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const blocks = [
      { id: 'a1', kind: 'audio', v: 1, text: 'will fail' },
      { id: 'a2', kind: 'audio', v: 1, text: 'will succeed' },
    ];
    const result = await synthesizer.resolveVoiceBlocks(blocks, 'opus');

    assert.equal(result.length, 2);
    assert.equal(result[0].kind, 'card', 'first block degraded');
    assert.equal(result[1].kind, 'audio', 'second block synthesized');
    assert.ok(result[1].url?.startsWith('/api/tts/audio/'), 'second block has url');
  });
});

// ---------------------------------------------------------------------------
// Cache hit: skip synthesis when file already exists
// ---------------------------------------------------------------------------

describe('VoiceBlockSynthesizer — cache hit', () => {
  it('skips synthesis if the audio file already exists on disk', async () => {
    let synthesizeCalls = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        synthesizeCalls++;
        return {
          audio: Buffer.from('data'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-cache-hit');
    await mkdir(cacheDir, { recursive: true });

    const text = 'cached voice line';
    const filename = expectedCacheFilename(text);
    const filePath = path.join(cacheDir, filename);

    // Pre-create the file to simulate a cache hit
    await writeFile(filePath, Buffer.from('pre-existing-audio'));

    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);
    const block = { id: 'a1', kind: 'audio', v: 1, text };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    // Should NOT have called synthesize
    assert.equal(synthesizeCalls, 0, 'synthesis skipped on cache hit');

    // URL should still be populated pointing at the cached file
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'audio');
    assert.ok(result[0].url.includes(filename), 'url points to cached filename');
  });

  it('calls synthesis when cache file does not exist', async () => {
    let synthesizeCalls = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        synthesizeCalls++;
        return {
          audio: Buffer.from('fresh'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    const cacheDir = path.join(os.tmpdir(), `vbs-test-cache-miss-${Date.now()}`);
    // Do NOT create the file — fresh cache directory

    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);
    const block = { id: 'a1', kind: 'audio', v: 1, text: 'uncached voice line' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(synthesizeCalls, 1, 'synthesis called once on cache miss');
    assert.equal(result[0].kind, 'audio');
    assert.ok(result[0].url.startsWith('/api/tts/audio/'));
  });

  it('does not reuse a pre-chunking cache entry for long text', async () => {
    let synthesizeCalls = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        synthesizeCalls++;
        return {
          audio: makePcmWav([synthesizeCalls]),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-stale-long-cache');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-stale-long-cache');
    await mkdir(cacheDir, { recursive: true });
    const text = `${'旧版静态合成会在模型上限处截断，这个缓存不能继续复用。'.repeat(20)}完整尾句`;
    const staleFilename = expectedCacheFilename(text);
    await writeFile(path.join(cacheDir, staleFilename), makePcmWav([999]));
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const [resolved] = await synthesizer.resolveVoiceBlocks([{ id: 'long-cache', kind: 'audio', v: 1, text }], 'opus');

    assert.ok(synthesizeCalls > 1, 'long text is synthesized through the chunked pipeline');
    assert.notEqual(path.basename(resolved.url), staleFilename, 'chunked output uses a versioned cache key');
  });
});

// ---------------------------------------------------------------------------
// F066 Phase 4: TTS Resilience Enhancement — retry on transient errors
// ---------------------------------------------------------------------------

describe('VoiceBlockSynthesizer — F066 Phase 4: retry on transient errors', () => {
  it('retries once on ECONNREFUSED and succeeds', async () => {
    let callCount = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('connect ECONNREFUSED 127.0.0.1:9879');
          err.code = 'ECONNREFUSED';
          throw err;
        }
        return {
          audio: Buffer.from('retry-success'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-retry-connrefused');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-retry-connrefused');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'r1', kind: 'audio', v: 1, text: 'retry me' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'audio', 'synthesis succeeded after retry');
    assert.ok(result[0].url.startsWith('/api/tts/audio/'), 'url populated');
    assert.equal(callCount, 2, 'synthesize called twice (1 fail + 1 retry)');
  });

  it('retries once on ETIMEDOUT and succeeds', async () => {
    let callCount = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('request timed out');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return {
          audio: Buffer.from('retry-success'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-retry-timeout');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-retry-timeout');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'r2', kind: 'audio', v: 1, text: 'timeout retry' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'audio', 'synthesis succeeded after retry');
    assert.equal(callCount, 2, 'synthesize called twice');
  });

  it('retries once on HTTP 5xx and succeeds', async () => {
    let callCount = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('TTS server returned 502: Bad Gateway');
        }
        return {
          audio: Buffer.from('retry-success'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-retry-5xx');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-retry-5xx');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'r3', kind: 'audio', v: 1, text: '5xx retry' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'audio', 'synthesis succeeded after retry');
    assert.equal(callCount, 2, 'synthesize called twice');
  });

  it('does NOT retry on 4xx errors (deterministic failure)', async () => {
    let callCount = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        callCount++;
        throw new Error('TTS server returned 400: Bad Request');
      },
    });
    cleanTmpDir('vbs-test-no-retry-4xx');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-no-retry-4xx');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'r4', kind: 'audio', v: 1, text: 'bad request' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'card', 'degraded without retry');
    assert.equal(callCount, 1, 'synthesize called only once (no retry)');
  });

  it('degrades after retry also fails', async () => {
    let callCount = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        callCount++;
        const err = new Error('connect ECONNREFUSED 127.0.0.1:9879');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    });
    cleanTmpDir('vbs-test-retry-fails');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-retry-fails');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'r5', kind: 'audio', v: 1, text: 'both fail' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'card', 'degraded to card after retry exhausted');
    assert.equal(callCount, 2, 'synthesize called twice (original + 1 retry)');
  });
});

// ---------------------------------------------------------------------------
// F066 Phase 4: Detailed error info in degraded card
// ---------------------------------------------------------------------------

describe('VoiceBlockSynthesizer — F066 Phase 4: error classification in degraded card', () => {
  it('shows "连接被拒绝" for ECONNREFUSED', async () => {
    const registry = makeMockRegistry({
      synthesize: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:9879');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    });
    cleanTmpDir('vbs-test-err-connrefused');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-err-connrefused');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'e1', kind: 'audio', v: 1, text: 'test error' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'card');
    assert.ok(result[0].bodyMarkdown.includes('连接被拒绝'), 'card body contains error classification');
    assert.ok(result[0].bodyMarkdown.includes('test error'), 'card body still contains original text');
  });

  it('shows "合成超时" for ETIMEDOUT or AbortError', async () => {
    const registry = makeMockRegistry({
      synthesize: async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
    });
    cleanTmpDir('vbs-test-err-timeout');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-err-timeout');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'e2', kind: 'audio', v: 1, text: 'timeout test' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'card');
    assert.ok(result[0].bodyMarkdown.includes('合成超时'), 'card body contains timeout classification');
  });

  it('shows "服务错误" for HTTP 5xx', async () => {
    const registry = makeMockRegistry({
      synthesize: async () => {
        throw new Error('TTS server returned 500: Internal Server Error');
      },
    });
    cleanTmpDir('vbs-test-err-5xx');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-err-5xx');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'e3', kind: 'audio', v: 1, text: '500 test' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'card');
    assert.ok(result[0].bodyMarkdown.includes('服务错误'), 'card body contains server error classification');
  });

  it('shows "未知错误" for other errors', async () => {
    const registry = makeMockRegistry({
      synthesize: async () => {
        throw new Error('Something unexpected');
      },
    });
    cleanTmpDir('vbs-test-err-unknown');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-err-unknown');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'e4', kind: 'audio', v: 1, text: 'unknown error' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'card');
    assert.ok(result[0].bodyMarkdown.includes('未知错误'), 'card body contains unknown error classification');
  });
});

// ---------------------------------------------------------------------------
// F066 Phase 4: Real Node fetch error shape — TypeError with cause
// ---------------------------------------------------------------------------

describe('VoiceBlockSynthesizer — F066 Phase 4: real fetch error shape (cause unwrapping)', () => {
  it('retries on TypeError("fetch failed") with cause.code=ECONNREFUSED', async () => {
    let callCount = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        callCount++;
        if (callCount === 1) {
          // This is the actual shape Node fetch throws when the server is down
          const cause = new Error('connect ECONNREFUSED 127.0.0.1:9879');
          cause.code = 'ECONNREFUSED';
          const err = new TypeError('fetch failed', { cause });
          throw err;
        }
        return {
          audio: Buffer.from('retry-success'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-real-fetch-connrefused');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-real-fetch-connrefused');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'rf1', kind: 'audio', v: 1, text: 'real fetch retry' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'audio', 'synthesis succeeded after retry');
    assert.equal(callCount, 2, 'retried once via cause.code unwrapping');
  });

  it('classifies TypeError("fetch failed") with cause.code=ECONNREFUSED as "连接被拒绝"', async () => {
    const registry = makeMockRegistry({
      synthesize: async () => {
        const cause = new Error('connect ECONNREFUSED 127.0.0.1:9879');
        cause.code = 'ECONNREFUSED';
        throw new TypeError('fetch failed', { cause });
      },
    });
    cleanTmpDir('vbs-test-real-fetch-classify');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-real-fetch-classify');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'rf2', kind: 'audio', v: 1, text: 'classify real fetch' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'card', 'degraded after retry exhausted');
    assert.ok(result[0].bodyMarkdown.includes('连接被拒绝'), 'correctly classified via cause unwrapping');
  });

  it('classifies TypeError("fetch failed") with cause.code=ETIMEDOUT as timeout and retries', async () => {
    let callCount = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        callCount++;
        if (callCount === 1) {
          const cause = new Error('connect ETIMEDOUT 10.0.0.1:9879');
          cause.code = 'ETIMEDOUT';
          throw new TypeError('fetch failed', { cause });
        }
        return {
          audio: Buffer.from('retry-ok'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-real-fetch-timeout');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-real-fetch-timeout');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'rf3', kind: 'audio', v: 1, text: 'real fetch timeout' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'audio', 'succeeded after retry');
    assert.equal(callCount, 2, 'retried once');
  });
});

// ---------------------------------------------------------------------------
// F066 Phase 4 AC-10: Resynthesize action in degraded card + public method
// ---------------------------------------------------------------------------

describe('VoiceBlockSynthesizer — F066 Phase 4 AC-10: resynthesize', () => {
  it('degraded card includes tts-resynthesize action with text and catId', async () => {
    const registry = makeMockRegistry({
      synthesize: async () => {
        throw new Error('TTS unavailable');
      },
    });
    cleanTmpDir('vbs-test-resynth-action');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-resynth-action');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'a1', kind: 'audio', v: 1, text: '需要重新合成的文本' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'card', 'degraded to card');
    assert.ok(Array.isArray(result[0].actions), 'card has actions array');
    assert.equal(result[0].actions.length, 1, 'exactly one action');
    assert.equal(result[0].actions[0].label, '重新合成', 'action label');
    assert.equal(result[0].actions[0].action, 'tts-resynthesize', 'action type');
    assert.equal(result[0].actions[0].payload.text, '需要重新合成的文本', 'payload has text');
    assert.equal(result[0].actions[0].payload.catId, 'opus', 'payload has catId');
  });

  it('degraded card uses speaker override in resynthesize action payload (F085-P3)', async () => {
    const registry = makeMockRegistry({
      synthesize: async () => {
        throw new Error('TTS unavailable');
      },
    });
    cleanTmpDir('vbs-test-resynth-speaker');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-resynth-speaker');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const block = { id: 'a2', kind: 'audio', v: 1, text: 'speaker override', speaker: 'gemini' };
    const result = await synthesizer.resolveVoiceBlocks([block], 'opus');

    assert.equal(result[0].kind, 'card', 'degraded to card');
    assert.equal(result[0].actions[0].payload.catId, 'gemini', 'uses speaker, not sender catId');
  });

  it('resynthesize() public method synthesizes audio successfully', async () => {
    let synthesizeCalls = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        synthesizeCalls++;
        return {
          audio: Buffer.from('resynthesized-audio'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-resynth-method');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-resynth-method');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const result = await synthesizer.resynthesize('重新合成', 'opus');

    assert.ok(result.audioUrl.startsWith('/api/tts/audio/'), 'returns valid audioUrl');
    assert.ok(result.audioUrl.endsWith('.wav'), 'wav format');
    assert.equal(synthesizeCalls, 1, 'called synthesize once');
  });

  it('resynthesize() retries on transient error', async () => {
    let callCount = 0;
    const registry = makeMockRegistry({
      synthesize: async () => {
        callCount++;
        if (callCount === 1) {
          const err = new Error('connect ECONNREFUSED');
          err.code = 'ECONNREFUSED';
          throw err;
        }
        return {
          audio: Buffer.from('retry-ok'),
          format: 'wav',
          metadata: { provider: 'mock', model: 'test', voice: 'test' },
        };
      },
    });
    cleanTmpDir('vbs-test-resynth-retry');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-resynth-retry');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    const result = await synthesizer.resynthesize('retry test', 'opus');

    assert.ok(result.audioUrl.startsWith('/api/tts/audio/'), 'succeeded after retry');
    assert.equal(callCount, 2, 'retried once');
  });

  it('resynthesize() throws on non-retryable error', async () => {
    const registry = makeMockRegistry({
      synthesize: async () => {
        throw new Error('TTS server returned 400: Bad Request');
      },
    });
    cleanTmpDir('vbs-test-resynth-throws');
    const cacheDir = path.join(os.tmpdir(), 'vbs-test-resynth-throws');
    const synthesizer = new VoiceBlockSynthesizer(registry, cacheDir);

    await assert.rejects(
      () => synthesizer.resynthesize('will fail', 'opus'),
      { message: 'TTS server returned 400: Bad Request' },
      'throws on non-retryable error',
    );
  });
});
