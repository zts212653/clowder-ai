/**
 * F279 server-owned full-document cache runs — singleflight and scheduling.
 *
 * Split from monolithic document-cache-runs.test.js to honor the 350-line
 * hard cap (AGENTS.md 代码质量红线).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  closeHarness,
  createHarness,
  deferred,
  headers,
  loadDocument,
  saveDocument,
  waitFor,
} from './helpers/document-cache-run-test-helpers.js';

describe('F279 server-owned full-document cache runs — singleflight and scheduling', () => {
  const harnesses = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(closeHarness));
  });

  it('is idempotent per user/document and singleflights a shared asset across isolated users', async () => {
    const gate = deferred();
    const started = deferred();
    let streamCalls = 0;
    const harness = await createHarness(async function* () {
      streamCalls++;
      started.resolve();
      await gate.promise;
      yield { type: 'final', result: { audio: Buffer.from('complete-audio'), format: 'wav', durationSec: 1 } };
    });
    harnesses.push(harness);

    const first = { projectPath: '/repo', relativePath: 'first.md', contentDigest: 'digest' };
    const second = { projectPath: '/repo', relativePath: 'second.md', contentDigest: 'digest' };
    await saveDocument(harness.app, 'you', first, ['first-anchor']);
    await saveDocument(harness.app, 'other-user', second, ['second-anchor']);

    const cacheRequest = (userId, identity, anchor) =>
      harness.app.inject({
        method: 'POST',
        url: '/api/tts/listen/document/cache',
        headers: headers(userId),
        payload: { identity, sentences: [{ anchor, text: '共享的一句正文。' }] },
      });

    const [firstStart, duplicateStart, secondStart] = await Promise.all([
      cacheRequest('you', first, 'first-anchor'),
      cacheRequest('you', first, 'first-anchor'),
      cacheRequest('other-user', second, 'second-anchor'),
    ]);
    for (const response of [firstStart, duplicateStart, secondStart]) {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().cacheRun.active, true);
    }

    await started.promise;
    assert.equal(streamCalls, 1, 'same asset hash must synthesize only once');
    gate.resolve();

    await waitFor(async () => {
      const state = await loadDocument(harness.app, 'you', first);
      assert.equal(state.cache.cachedSentences, 1);
    });
    await waitFor(async () => {
      const state = await loadDocument(harness.app, 'other-user', second);
      assert.equal(state.cache.cachedSentences, 1);
    });

    const firstState = await loadDocument(harness.app, 'you', first);
    const secondState = await loadDocument(harness.app, 'other-user', second);
    assert.equal(firstState.sentences[0].assetId, secondState.sentences[0].assetId);
    assert.equal(firstState.cacheRun.active, false);
    assert.equal(secondState.cacheRun.active, false);
  });

  it('singleflights one sentence when cache and foreground listen reach the shared asset together', async () => {
    const gate = deferred();
    const started = deferred();
    let streamCalls = 0;
    const harness = await createHarness(async function* () {
      streamCalls++;
      started.resolve();
      await gate.promise;
      yield { type: 'final', result: { audio: Buffer.from('complete-audio'), format: 'wav', durationSec: 1 } };
    });
    harnesses.push(harness);
    const identity = { projectPath: '/repo', relativePath: 'shared-entry.md', contentDigest: 'digest' };
    await saveDocument(harness.app, 'you', identity, ['shared-anchor']);

    const cacheStart = await harness.app.inject({
      method: 'POST',
      url: '/api/tts/listen/document/cache',
      headers: headers('you'),
      payload: { identity, sentences: [{ anchor: 'shared-anchor', text: '缓存与播放共用的一句。' }] },
    });
    assert.equal(cacheStart.statusCode, 200, cacheStart.body);
    await started.promise;

    const playback = harness.app.inject({
      method: 'POST',
      url: '/api/tts/listen/stream',
      headers: headers('you'),
      payload: { text: '缓存与播放共用的一句。' },
    });
    gate.resolve();
    const playbackResponse = await playback;

    assert.equal(playbackResponse.statusCode, 200, playbackResponse.body);
    assert.equal(streamCalls, 1, 'cache and playback must share the in-flight asset synthesis');
    await waitFor(async () => {
      const state = await loadDocument(harness.app, 'you', identity);
      assert.equal(state.cache.cachedSentences, 1);
    });
  });

  it('rejects ephemeral sentence input that no longer matches the saved manifest', async () => {
    const harness = await createHarness(async function* () {
      yield { type: 'final', result: { audio: Buffer.from('unused'), format: 'wav', durationSec: 1 } };
    });
    harnesses.push(harness);
    const identity = { projectPath: '/repo', relativePath: 'manifest.md', contentDigest: 'digest' };
    await saveDocument(harness.app, 'you', identity, ['known-anchor']);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/tts/listen/document/cache',
      headers: headers('you'),
      payload: { identity, sentences: [{ anchor: 'unknown-anchor', text: 'This must never enter persistence.' }] },
    });

    assert.equal(response.statusCode, 409, response.body);
    const state = await loadDocument(harness.app, 'you', identity);
    assert.deepEqual(state.sentences, [{ anchor: 'known-anchor' }]);
  });

  it('lets a foreground playback miss reach the existing worker before the next background sentence', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order = [];
    const harness = await createHarness(async function* (request) {
      order.push(request.text);
      if (request.text === '后台第一句。') {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      yield { type: 'final', result: { audio: Buffer.from(request.text), format: 'wav', durationSec: 1 } };
    });
    harnesses.push(harness);
    const identity = { projectPath: '/repo', relativePath: 'priority.md', contentDigest: 'digest' };
    await saveDocument(harness.app, 'you', identity, ['background-first', 'background-second']);

    const started = await harness.app.inject({
      method: 'POST',
      url: '/api/tts/listen/document/cache',
      headers: headers('you'),
      payload: {
        identity,
        sentences: [
          { anchor: 'background-first', text: '后台第一句。' },
          { anchor: 'background-second', text: '后台第二句。' },
        ],
      },
    });
    assert.equal(started.statusCode, 200, started.body);
    await firstStarted.promise;

    releaseFirst.resolve();
    const playback = await harness.app.inject({
      method: 'POST',
      url: '/api/tts/listen/stream',
      headers: headers('you'),
      payload: { text: '播放缺失句。' },
    });
    assert.equal(playback.statusCode, 200, playback.body);
    await waitFor(() => assert.equal(order.length, 3));
    assert.deepEqual(order, ['后台第一句。', '播放缺失句。', '后台第二句。']);
  });
});
