import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { VoicePeer } from './peer.mjs';

const require = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const flush = () => new Promise((done) => setImmediate(done));

test('real surface keeps screen failure visible through speech events and labels its actions', async (t) => {
  const dom = new JSDOM(await readFile(new URL('./index.html', import.meta.url), 'utf8'));
  const saved = new Map(
    ['window', 'document', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: {
      mediaDevices: {
        getDisplayMedia: async () => {
          throw new DOMException('Permission denied', 'NotAllowedError');
        },
      },
    },
  }))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  let peer;
  let event;
  const resized = [];
  window.live = {
    info: async () => ({ synthetic: false, documentsAllowed: true, hostBacked: true }),
    arm: async () => {},
    start: async () => {},
    stop: async () => {},
    record() {},
    screenRequest: async () => 'clicked-selection',
    screenStop: async () => {},
    resize: (expanded) => resized.push(expanded),
    onEvent: (callback) => {
      event = callback;
    },
  };
  t.mock.method(VoicePeer.prototype, 'offer', async function () {
    peer = this;
    this.onEvent({ type: 'connected' });
    return 'fixture-sdp';
  });
  t.mock.method(VoicePeer.prototype, 'close', async () => {});
  const $ = (id) => document.getElementById(id);
  try {
    await import(`./surface.mjs?fixture=${Date.now()}`);
    await $('begin').onclick();
    $('share').onclick();
    await flush();
    const screenState = $('screen-status');
    assert.ok(screenState, 'screen feedback must have its own persistent place');
    assert.match(screenState.textContent, /未能开始共享/);
    peer.onEvent({ type: 'turn-done', role: 'assistant', transcript: '我在。', turnId: 't1' });
    event({ type: 'tool', phase: 'item/completed', name: 'cat_cafe_search_evidence', status: 'completed' });
    assert.match(screenState.textContent, /未能开始共享/);
    assert.equal(screenState.hidden, false);
    assert.match($('share').textContent, /共享屏幕/);
    assert.match($('end').textContent, /结束/);
    assert.match($('write').textContent, /文字/);
    $('mic').onclick();
    assert.match($('mic').textContent, /取消静音/);
    $('write').onclick();
    assert.equal($('details').hidden, false);
    assert.equal(resized.at(-1), true);
    $('collapse').onclick();
    assert.equal($('details').hidden, true);
    assert.equal(document.body.className, 'connected');
  } finally {
    $('end').onclick?.();
    await flush();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
