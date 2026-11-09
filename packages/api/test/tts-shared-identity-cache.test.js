import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { startSharedCacheProcess } from './helpers/tts-shared-cache-process.js';

const breeze = 'mlx-community/Breeze-TTS-2-mlx';
const qwen = 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16';
const policy = 'breeze-repetition-1.06-v1';
const setup = fileURLToPath(new URL('./helpers/setup-cat-registry.js', import.meta.url));
const worker = fileURLToPath(new URL('./helpers/tts-shared-cache-worker.js', import.meta.url));

function wav(amplitude) {
  const audio = Buffer.alloc(52);
  audio.write('RIFF');
  audio.writeUInt32LE(44, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(8, 40);
  audio.writeInt16LE(amplitude, 44);
  return audio;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tts-shared-cache-'));
  const state = { model: breeze, profile: null, offline: false, posts: 0, delay: false, delaySecond: false };
  let releaseOld;
  let releaseSecond;
  let observed;
  let observedSecond;
  const delayed = new Promise((resolve) => {
    observed = resolve;
  });
  const secondDelayed = new Promise((resolve) => {
    observedSecond = resolve;
  });
  const server = createServer(async (req, res) => {
    if (state.offline) {
      res.writeHead(503).end();
      return;
    }
    if (req.url === '/before-health') {
      releaseOld = () => {
        releaseOld = undefined;
        res.writeHead(204).end();
      };
      observed();
      return;
    }
    if (req.url === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        model: state.model,
        backend: 'qwen3-clone',
        capabilities: ['speech-stream-route-v1'],
        ...(state.profile ? { generation_profile: state.profile } : {}),
      });
      if (state.delay && req.headers['x-tts-test-worker'] === 'slow-old') {
        state.delay = false;
        releaseOld = () => {
          releaseOld = undefined;
          res.writeHead(200, { 'content-type': 'application/json' }).end(body);
        };
        observed();
        return;
      }
      if (state.delaySecond && req.headers['x-tts-test-worker'] === 'older-probe') {
        state.delaySecond = false;
        releaseSecond = () => {
          releaseSecond = undefined;
          res.writeHead(200, { 'content-type': 'application/json' }).end(body);
        };
        observedSecond();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      return;
    }
    state.posts++;
    req.resume();
    res.writeHead(200, {
      'content-type': 'application/x-ndjson',
      ...(state.profile ? { 'x-tts-generation-profile': state.profile } : {}),
    });
    res.end(
      `${JSON.stringify({ type: 'final', audio_base64: wav(state.profile ? 12000 : 8000).toString('base64') })}\n`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const started = [];
  t.after(async () => {
    releaseOld?.();
    releaseSecond?.();
    await Promise.all(started.map((actor) => actor.close()));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const actors = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const actor = await startSharedCacheProcess({ worker, setup, cacheDir: root, baseUrl: url });
      started.push(actor);
      return actor;
    }),
  );
  return {
    root,
    state,
    delayed,
    secondDelayed,
    release: () => releaseOld?.(),
    releaseSecond: () => releaseSecond?.(),
    request(id, model = breeze) {
      const slot =
        id === 'slow-old' || id === 'late-send' ? 1 : id === 'older-probe' ? 2 : id.startsWith('offline') ? 3 : 0;
      return actors[slot].request(id, model);
    },
  };
}

for (const schedule of ['old-response-late', 'new-request-late']) {
  test(`conflicting independent observations fail offline, then reconfirm (${schedule})`, async (t) => {
    const f = await fixture(t);
    let old;
    let current;
    if (schedule === 'old-response-late') {
      old = await f.request('seed-old');
      f.state.delay = true;
      const pending = f.request('slow-old');
      await f.delayed;
      f.state.profile = policy;
      current = await f.request('new-policy');
      f.release();
      await pending;
    } else {
      const pending = f.request('late-send');
      await f.delayed;
      old = await f.request('old-policy');
      f.state.profile = policy;
      f.release();
      current = await pending;
    }
    assert.notEqual(current.assetId, old.assetId);
    f.state.offline = true;
    for (const model of [breeze, 'auto']) {
      await assert.rejects(f.request('offline-conflict', model), /ambiguous/i);
    }
    assert.equal(f.state.posts, 2, 'uncertain offline reads never infer or generate');
    f.state.offline = false;
    const confirmed = await f.request('confirm-current');
    assert.equal(confirmed.cached, true);
    assert.equal(confirmed.assetId, current.assetId);
    f.state.offline = true;
    for (const model of [breeze, 'auto']) {
      const replay = await f.request('offline-confirmed', model);
      assert.equal(replay.cached, true);
      assert.equal(replay.assetId, current.assetId);
      assert.equal((await readFile(join(f.root, replay.assetId))).readInt16LE(44), 12000);
    }
    assert.equal(f.state.posts, 2);
  });
}

test('concurrent matching observations retain offline cache availability across processes', async (t) => {
  const f = await fixture(t);
  f.state.profile = policy;
  const current = await f.request('seed');
  f.state.delay = true;
  const pending = f.request('slow-old');
  await f.delayed;
  assert.equal((await f.request('same-profile')).assetId, current.assetId);
  f.release();
  await pending;
  f.state.offline = true;
  assert.equal((await f.request('offline')).assetId, current.assetId);
  assert.equal(f.state.posts, 1);
});

test('an older in-flight different probe invalidates even a later live reconfirmation', async (t) => {
  const f = await fixture(t);
  const receipt = () => {
    const db = new Database(join(f.root, '.tts-identities.sqlite'));
    try {
      return db.prepare('SELECT revision, ambiguous FROM endpoint_identity').get();
    } finally {
      db.close();
    }
  };
  const legacy = await f.request('seed-old');
  f.state.delay = true;
  const oldA = f.request('slow-old');
  await f.delayed;
  f.state.delaySecond = true;
  const oldB = f.request('older-probe');
  await f.secondDelayed;
  f.state.profile = policy;
  const current = await f.request('new');
  f.release();
  const firstOld = await oldA;
  assert.equal(firstOld.healthSuccesses, 1);
  assert.equal(firstOld.healthFailures, 0);
  assert.equal(firstOld.assetId, legacy.assetId);
  assert.equal((await f.request('reconfirm')).assetId, current.assetId);
  const confirmed = receipt();
  assert.equal(confirmed.ambiguous, 0);
  f.releaseSecond();
  const secondOld = await oldB;
  assert.equal(secondOld.healthSuccesses, 1);
  assert.equal(secondOld.healthFailures, 0);
  assert.equal(secondOld.assetId, legacy.assetId);
  const invalidated = receipt();
  assert.equal(invalidated.ambiguous, 1);
  assert.notEqual(invalidated.revision, confirmed.revision, 'late successful health actually committed its conflict');
  f.state.offline = true;
  await assert.rejects(f.request('offline-late-conflict'), /ambiguous/i);
  f.state.offline = false;
  assert.equal((await f.request('confirm-again')).assetId, current.assetId);
  f.state.offline = true;
  assert.equal((await f.request('offline-final')).assetId, current.assetId);
  assert.equal(f.state.posts, 2);
});

test('selected Qwen/Breeze and auto discovery share the endpoint conflict state', async (t) => {
  const f = await fixture(t);
  f.state.model = qwen;
  await f.request('seed-qwen', qwen);
  f.state.delay = true;
  const old = f.request('slow-old', qwen);
  await f.delayed;
  f.state.model = breeze;
  f.state.profile = policy;
  const current = await f.request('breeze');
  f.release();
  await old;
  f.state.offline = true;
  for (const model of [qwen, breeze, 'auto']) {
    await assert.rejects(f.request('offline-conflict', model), /ambiguous/i);
  }
  f.state.offline = false;
  assert.equal((await f.request('confirm-breeze')).assetId, current.assetId);
  f.state.offline = true;
  assert.equal((await f.request('offline-breeze')).assetId, current.assetId);
  assert.equal((await f.request('offline-auto', 'auto')).assetId, current.assetId);
  await assert.rejects(f.request('offline-qwen', qwen), /differs from the selected model/i);
  assert.equal(f.state.posts, 2);
});

test('fresh processes follow real old/new/rollback transitions without changing offline audio', async (t) => {
  const f = await fixture(t);
  const old = await f.request('old');
  f.state.profile = policy;
  const current = await f.request('new');
  assert.notEqual(current.assetId, old.assetId);
  f.state.offline = true;
  assert.equal((await f.request('offline-new')).assetId, current.assetId);
  f.state.offline = false;
  f.state.profile = null;
  assert.equal((await f.request('real-rollback')).assetId, old.assetId);
  f.state.offline = true;
  assert.equal((await f.request('offline-rollback')).assetId, old.assetId);
  assert.equal(f.state.posts, 2);
});
