/**
 * F279 server-owned full-document cache runs — lifecycle and stale fences.
 *
 * Split from monolithic document-cache-runs.test.js to honor the 350-line
 * hard cap (AGENTS.md 代码质量红线).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { ttsRoutes } from '../dist/routes/tts.js';
import {
  closeHarness,
  createHarness,
  deferred,
  headers,
  loadDocument,
  saveDocument,
  waitFor,
} from './helpers/document-cache-run-test-helpers.js';

describe('F279 server-owned full-document cache runs — lifecycle and stale fences', () => {
  const harnesses = [];

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(closeHarness));
  });

  it('fences late results after clear, digest edit, and voice-fingerprint changes', async () => {
    const gates = [];
    let streamCalls = 0;
    const harness = await createHarness(async function* () {
      streamCalls++;
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      yield {
        type: 'final',
        result: { audio: Buffer.from(`late-${streamCalls}`), format: 'wav', durationSec: 1 },
      };
    });
    harnesses.push(harness);

    const identity = { projectPath: '/repo', relativePath: 'race.md', contentDigest: 'digest-a' };
    const start = async (synthesis) => {
      const previousGateCount = gates.length;
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/tts/listen/document/cache',
        headers: headers('you'),
        payload: { identity, synthesis, sentences: [{ anchor: 'anchor-a', text: '会晚到的正文。' }] },
      });
      assert.equal(response.statusCode, 200, response.body);
      await waitFor(() => assert.equal(gates.length, previousGateCount + 1));
    };

    await saveDocument(harness.app, 'you', identity, ['anchor-a'], { voice: 'voice-a' });
    await start({ voice: 'voice-a' });
    const clear = await harness.app.inject({
      method: 'DELETE',
      url: '/api/tts/listen/document/audio',
      headers: headers('you'),
      payload: { projectPath: identity.projectPath, relativePath: identity.relativePath },
    });
    assert.equal(clear.statusCode, 200, clear.body);
    gates.shift().resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await loadDocument(harness.app, 'you', identity)).cache.cachedSentences, 0);

    await start({ voice: 'voice-a' });
    const edited = { ...identity, contentDigest: 'digest-b' };
    await saveDocument(harness.app, 'you', edited, ['anchor-a'], { voice: 'voice-a' });
    gates.shift().resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await loadDocument(harness.app, 'you', edited)).cache.cachedSentences, 0);

    await saveDocument(harness.app, 'you', identity, ['anchor-a'], { voice: 'voice-a' });
    await start({ voice: 'voice-a' });
    await saveDocument(harness.app, 'you', identity, ['anchor-a'], { voice: 'voice-b' });
    gates.shift().resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await loadDocument(harness.app, 'you', identity)).cache.cachedSentences, 0);
  });

  it('cancels only the active remainder and preserves already-linked cache progress', async () => {
    const secondStarted = deferred();
    const releaseSecond = deferred();
    const harness = await createHarness(async function* (request) {
      if (request.text === '第二句。') {
        secondStarted.resolve();
        await releaseSecond.promise;
      }
      yield { type: 'final', result: { audio: Buffer.from(request.text), format: 'wav', durationSec: 1 } };
    });
    harnesses.push(harness);
    const identity = { projectPath: '/repo', relativePath: 'cancel.md', contentDigest: 'digest' };
    await saveDocument(harness.app, 'you', identity, ['first', 'second']);
    const started = await harness.app.inject({
      method: 'POST',
      url: '/api/tts/listen/document/cache',
      headers: headers('you'),
      payload: {
        identity,
        sentences: [
          { anchor: 'first', text: '第一句。' },
          { anchor: 'second', text: '第二句。' },
        ],
      },
    });
    assert.equal(started.statusCode, 200, started.body);
    await secondStarted.promise;
    const synthesisFingerprint = started.json().synthesisFingerprint;
    assert.equal(typeof synthesisFingerprint, 'string');

    const cancelled = await harness.app.inject({
      method: 'DELETE',
      url: '/api/tts/listen/document/cache',
      headers: headers('you'),
      payload: { ...identity, synthesisFingerprint },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().cancelled, true);
    assert.equal(cancelled.json().cache.cachedSentences, 1);
    releaseSecond.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const state = await loadDocument(harness.app, 'you', identity);
    assert.equal(state.cache.cachedSentences, 1);
    assert.equal(state.cacheRun.active, false);
  });

  it('projects partial cache after an API restart without resuming synthesis', async () => {
    const secondStarted = deferred();
    const secondAborted = deferred();
    let streamCalls = 0;
    const harness = await createHarness(async function* (request, options) {
      streamCalls++;
      if (request.text === '重启后不续跑的第二句。') {
        secondStarted.resolve();
        await new Promise((resolve) => options?.signal?.addEventListener('abort', resolve, { once: true }));
        secondAborted.resolve();
        options?.signal?.throwIfAborted();
      }
      yield { type: 'final', result: { audio: Buffer.from(request.text), format: 'wav', durationSec: 1 } };
    });
    harnesses.push(harness);
    const identity = { projectPath: '/repo', relativePath: 'restart.md', contentDigest: 'digest' };
    await saveDocument(harness.app, 'you', identity, ['first', 'second']);
    const started = await harness.app.inject({
      method: 'POST',
      url: '/api/tts/listen/document/cache',
      headers: headers('you'),
      payload: {
        identity,
        sentences: [
          { anchor: 'first', text: '已缓存的第一句。' },
          { anchor: 'second', text: '重启后不续跑的第二句。' },
        ],
      },
    });
    assert.equal(started.statusCode, 200, started.body);
    await secondStarted.promise;
    await harness.app.close();
    harness.appClosed = true;
    await secondAborted.promise;

    const restarted = Fastify({ logger: false });
    await restarted.register(ttsRoutes, {
      ttsRegistry: harness.registry,
      cacheDir: harness.tempDir,
      documentListenRepository: harness.repository,
    });
    try {
      const state = await loadDocument(restarted, 'you', identity);
      assert.deepEqual(state.cache, {
        cachedSentences: 1,
        totalSentences: 2,
        totalBytes: Buffer.byteLength('已缓存的第一句。'),
      });
      assert.equal(state.cacheRun.active, false);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(streamCalls, 2, 'restart must not submit the remaining sentence automatically');
    } finally {
      await restarted.close();
    }
  });

  it('does not let a stale cancel request stop a newer digest and voice run', async () => {
    const oldStarted = deferred();
    const newStarted = deferred();
    const harness = await createHarness(async function* (request, options) {
      if (request.text === '旧版本句子。') oldStarted.resolve();
      else newStarted.resolve();
      await new Promise((resolve) => options?.signal?.addEventListener('abort', resolve, { once: true }));
      options?.signal?.throwIfAborted();
    });
    harnesses.push(harness);
    const original = { projectPath: '/repo', relativePath: 'stale-cancel.md', contentDigest: 'digest-a' };
    await saveDocument(harness.app, 'you', original, ['anchor'], { voice: 'voice-a' });
    const oldStart = await harness.app.inject({
      method: 'POST',
      url: '/api/tts/listen/document/cache',
      headers: headers('you'),
      payload: {
        identity: original,
        synthesis: { voice: 'voice-a' },
        sentences: [{ anchor: 'anchor', text: '旧版本句子。' }],
      },
    });
    assert.equal(oldStart.statusCode, 200, oldStart.body);
    await oldStarted.promise;

    const replacement = { ...original, contentDigest: 'digest-b' };
    await saveDocument(harness.app, 'you', replacement, ['anchor'], { voice: 'voice-b' });
    const newStart = await harness.app.inject({
      method: 'POST',
      url: '/api/tts/listen/document/cache',
      headers: headers('you'),
      payload: {
        identity: replacement,
        synthesis: { voice: 'voice-b' },
        sentences: [{ anchor: 'anchor', text: '新版本句子。' }],
      },
    });
    assert.equal(newStart.statusCode, 200, newStart.body);
    await newStarted.promise;

    const staleCancel = await harness.app.inject({
      method: 'DELETE',
      url: '/api/tts/listen/document/cache',
      headers: headers('you'),
      payload: { ...original, synthesisFingerprint: oldStart.json().synthesisFingerprint },
    });
    assert.equal(staleCancel.statusCode, 200, staleCancel.body);
    assert.equal(staleCancel.json().cancelled, false);
    assert.equal(staleCancel.json().cacheRun.active, true);

    const currentCancel = await harness.app.inject({
      method: 'DELETE',
      url: '/api/tts/listen/document/cache',
      headers: headers('you'),
      payload: { ...replacement, synthesisFingerprint: newStart.json().synthesisFingerprint },
    });
    assert.equal(currentCancel.statusCode, 200, currentCancel.body);
    assert.equal(currentCancel.json().cancelled, true);
  });
});
