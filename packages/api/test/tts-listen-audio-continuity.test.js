import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { TtsRegistry } from '../dist/domains/cats/services/tts/TtsRegistry.js';
import { ttsRoutes } from '../dist/routes/tts.js';

const SAMPLE_RATE = 24_000;

function pcm16Wav(samples) {
  const output = Buffer.alloc(44 + samples.length * 2);
  output.write('RIFF', 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVE', 8);
  output.write('fmt ', 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => {
    output.writeInt16LE(sample, 44 + index * 2);
  });
  return output;
}

function wavSamples(wav) {
  const samples = [];
  for (let offset = 44; offset < wav.length; offset += 2) samples.push(wav.readInt16LE(offset));
  return samples;
}

function parseEvents(body) {
  return body
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

describe('F279 listen audio continuity', () => {
  let app;
  let sourceWav;
  let tempDir;

  before(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'tts-listen-continuity-'));
    sourceWav = pcm16Wav([
      ...Array.from({ length: SAMPLE_RATE / 2 }, () => 0),
      ...Array.from({ length: SAMPLE_RATE / 10 }, () => 2_000),
    ]);
    const registry = new TtsRegistry();
    registry.register({
      id: 'continuity-tts',
      model: 'test-model',
      synthesize: async () => ({ audio: sourceWav, format: 'wav', durationSec: 0.6 }),
      stream: async function* () {
        yield { type: 'chunk', audio: sourceWav, format: 'wav', durationSec: 0.6, isFinalChunk: true };
        yield { type: 'final', result: { audio: sourceWav, format: 'wav', durationSec: 0.6 } };
      },
    });
    app = Fastify({ logger: false });
    await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir: tempDir });
    await app.ready();
  });

  after(async () => {
    await app.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('versions listen assets separately and removes model startup silence before caching', async () => {
    const headers = { 'x-cat-cafe-user': 'you', 'content-type': 'application/json' };
    const text = '连续听读不能每句先空半秒。';
    const generic = await app.inject({ method: 'POST', url: '/api/tts/synthesize', headers, payload: { text } });
    const listen = await app.inject({ method: 'POST', url: '/api/tts/listen/stream', headers, payload: { text } });
    const events = parseEvents(listen.body);
    const asset = events.find((event) => event.type === 'asset');

    assert.equal(generic.statusCode, 200);
    assert.equal(listen.statusCode, 200);
    assert.ok(asset);
    assert.notEqual(asset.assetId, generic.json().assetId, 'listen post-processing must invalidate old raw assets');

    const processed = await readFile(path.join(tempDir, asset.assetId));
    const samples = wavSamples(processed);
    const firstSignal = samples.findIndex((sample) => Math.abs(sample) >= 328);

    assert.equal(processed.readUInt32LE(4), processed.length - 8, 'RIFF size must describe the trimmed asset');
    assert.equal(processed.readUInt32LE(40), processed.length - 44, 'data size must describe the trimmed PCM');
    assert.ok(processed.length < sourceWav.length / 2, 'the 500ms startup pad should not survive in the cache');
    assert.ok(firstSignal >= 0 && firstSignal <= SAMPLE_RATE * 0.025, `unexpected preserved silence: ${firstSignal}`);
    assert.ok(asset.durationSec <= 0.13, `duration must describe trimmed audio, got ${asset.durationSec}`);
  });
});
