// Entirely in-memory renderer test: no process, network, microphone, or real browser access.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const { JSDOM } = require('jsdom');

test('grant reconnect preserves controls and an uncertain text retry retains its message identity', async () => {
  const dom = new JSDOM(await readFile(new URL('./index.html', import.meta.url), 'utf8'));
  const saved = new Map(
    ['window', 'document', 'navigator', 'AudioContext', 'RTCPeerConnection', 'Audio', 'MediaStream'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const tracks = [];
  const outputs = [];
  let eventHandler;
  const textRequests = [];
  let acceptText = false;
  dom.window.live = {
    info: async () => ({ synthetic: false, documentsAllowed: false }),
    arm: async () => {},
    start: async () => {
      eventHandler({ type: 'answer', sdp: 'synthetic answer' });
    },
    stop: async function closeOwnedTestSession() {},
    screenStop: async () => {},
    documents: async () => ({ allowed: true, changed: true }),
    resize() {},
    record() {},
    text: async (text, id) => {
      textRequests.push({ text, id });
      if (!acceptText) throw new Error('接收尚未确认');
      return { delivery: 'accepted' };
    },
    onEvent(callback) {
      eventHandler = callback;
    },
  };
  const mocks = {
    window: dom.window,
    document: dom.window.document,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          const track = { enabled: true, stop() {} };
          tracks.push(track);
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
      },
    },
    AudioContext: class {
      async resume() {}
      async close() {}
    },
    RTCPeerConnection: class {
      iceGatheringState = 'complete';
      localDescription = { sdp: 'synthetic offer' };
      addTrack() {}
      createDataChannel() {
        return {};
      }
      async createOffer() {
        return {};
      }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      getReceivers() {
        return [{ track: { kind: 'audio' } }];
      }
      close() {}
    },
    MediaStream: class {},
    Audio: class {
      constructor() {
        outputs.push(this);
      }
      async play() {}
      pause() {}
    },
  };
  try {
    for (const [key, value] of Object.entries(mocks))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    await import(`./surface.mjs?test=${Date.now()}`);
    const $ = (id) => dom.window.document.getElementById(id);
    await $('begin').onclick();
    $('mic').onclick();
    $('speaker').onclick();
    await $('documents').onclick();
    assert.equal(tracks.length, 2);
    assert.equal(tracks[1].enabled, false);
    assert.equal(outputs[1].muted, true);
    assert.equal($('mic').getAttribute('aria-pressed'), 'true');
    $('message').value = '补充一个条件';
    await $('compose').onsubmit({ preventDefault() {} });
    assert.equal($('message').value, '补充一个条件');
    acceptText = true;
    await $('compose').onsubmit({ preventDefault() {} });
    assert.equal(textRequests[0].id, textRequests[1].id);
    assert.equal($('message').value, '');
    $('message').value = '补充一个条件';
    await $('compose').onsubmit({ preventDefault() {} });
    assert.notEqual(textRequests[2].id, textRequests[1].id, 'a later intentional repeat is a new user message');
    await $('end').onclick();
  } finally {
    // Close through the fake surface so its real JS timer never survives this test.
    await dom.window.document.getElementById('end').onclick?.();
    await new Promise((resolve) => setImmediate(resolve));
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
