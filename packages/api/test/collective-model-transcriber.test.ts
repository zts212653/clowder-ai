import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServiceConfig } from '../src/domains/services/service-manifest.js';
import { createConfiguredCollectiveTranscriber } from '../src/infrastructure/connectors/media/CollectiveSttProvider.js';

test('model audio never calls an implicit default, disabled service or a remote endpoint', async () => {
  for (const config of [undefined, { enabled: false, port: 22345 }, { enabled: true, installed: true }]) {
    let calls = 0;
    const transcribe = createConfiguredCollectiveTranscriber({
      getConfig: () => config,
      getEnv: () => ({}),
      fetchImpl: async () => {
        calls++;
        throw new Error('No implicit HTTP request is allowed');
      },
    });
    assert.equal(await transcribe({ audioPath: '/unused', signal: new AbortController().signal }), undefined);
    assert.equal(calls, 0);
  }
  let calls = 0;
  const remote = createConfiguredCollectiveTranscriber({
    getConfig: () => ({ enabled: true, port: 22345 }),
    getEnv: () => ({ WHISPER_URL: 'https://unapproved.invalid' }),
    fetchImpl: async () => {
      calls++;
      throw new Error('No remote endpoint is allowed');
    },
  });
  assert.equal(await remote({ audioPath: '/unused', signal: new AbortController().signal }), undefined);
  assert.equal(calls, 0);
});

test('the explicit healthy current service receives actual audio through the original provider; redirects and late config changes cannot reroute it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-explicit-transcriber-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audioPath = join(directory, 'selected.wav');
  await writeFile(audioPath, 'explicit fixture audio');
  let config: ServiceConfig = { enabled: true, installed: true, port: 22345, selectedModel: 'whisper-test' };
  const calls: { url: string; redirect?: RequestRedirect }[] = [];
  let changeDuringPost = false,
    wrongHealth = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    if (url.endsWith('/health'))
      return Response.json({ model: wrongHealth ? 'another-model' : 'whisper-test', backend: 'faster-whisper' });
    const form = init?.body;
    assert.ok(form instanceof FormData);
    const file = form.get('file');
    assert.ok(file instanceof Blob);
    assert.equal(await file.text(), 'explicit fixture audio');
    if (changeDuringPost) config = { ...config, port: 22346 };
    return Response.json({ text: 'original explicit transcript' });
  };
  const transcribe = createConfiguredCollectiveTranscriber({ getConfig: () => config, getEnv: () => ({}), fetchImpl });
  const request = { audioPath, signal: new AbortController().signal };
  assert.deepEqual(await transcribe(request), { text: 'original explicit transcript', provider: 'whisper-local' });
  assert.deepEqual(
    calls.map((call) => call.url),
    ['http://127.0.0.1:22345/health', 'http://127.0.0.1:22345/v1/audio/transcriptions'],
  );
  changeDuringPost = true;
  assert.equal(await transcribe(request), undefined);
  changeDuringPost = false;
  wrongHealth = true;
  const count = calls.length;
  assert.equal(await transcribe(request), undefined);
  assert.equal(calls.length, count + 1, 'Wrong live model identity must never reach transcription');
});
