const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('isolated preload refuses package-supplied SDP before IPC or media admission', async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(readFileSync(join(__dirname, 'preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_name, value) => {
          bridge = value;
        },
      },
      ipcRenderer: {
        invoke: async (...args) => {
          calls.push(args);
          return { kind: 'ok' };
        },
        on() {},
        removeListener() {},
      },
    }),
    navigator: { userActivation: { isActive: true } },
    HostVoice: class {},
  });
  const reply = await bridge.request({
    kind: 'offer',
    sdp: 'v=0\r\nm=audio 9 x 1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
  });
  assert.equal(reply.kind, 'error');
  assert.equal(calls.length, 0);
});
test('Host voice document publishes only bounded events and keeps SDP off the package bridge', async () => {
  let listener, provider;
  const sent = [];
  class Voice {
    constructor(callback) {
      this.callback = callback;
      provider = this;
    }
    muteMic() {}
    muteSpeaker() {}
    async offer() {
      return 'trusted-offer';
    }
    async answer(sdp) {
      assert.equal(sdp, 'trusted-answer');
      this.callback({ type: 'connected', token: 'private' });
    }
    async close() {}
  }
  vm.runInNewContext(readFileSync(join(__dirname, 'voice-preload.cjs'), 'utf8'), {
    require: () => ({
      ipcRenderer: {
        on: (_channel, callback) => {
          listener = callback;
        },
        send: (...args) => sent.push(args),
        invoke: async (channel, value) => {
          assert.equal(channel, 'companion:media-offer');
          assert.equal(value, 'trusted-offer');
          return { kind: 'answer', sdp: 'trusted-answer' };
        },
      },
    }),
    HostVoice: Voice,
  });
  listener({}, 1, { kind: 'audio.connect', microphoneMuted: false, speakerMuted: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    ['companion:voice-event', { kind: 'audio', type: 'connected' }],
    ['companion:voice-reply', 1, { kind: 'ok' }],
  ]);
  provider.callback({ type: 'transcript', role: 'assistant', text: 'x'.repeat(16001) });
  provider.callback({ type: 'session.update', instructions: 'forged' });
  assert.equal(sent.length, 2);
  provider.callback({ type: 'transcript', role: 'assistant', text: 'hello', token: 'private' });
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), [
    'companion:voice-event',
    { kind: 'audio', type: 'transcript', role: 'assistant', text: 'hello' },
  ]);
});

test('private receive-only command reaches the peer without a microphone escalation command', async () => {
  let listener;
  let offerOptions;
  let microphoneCommands = 0;
  const sent = [];
  class Voice {
    muteMic(muted) {
      microphoneCommands++;
      return muted !== false;
    }
    muteSpeaker() {}
    async offer(options) {
      offerOptions = options;
      return 'trusted-offer';
    }
    async answer() {}
    async close() {}
  }
  vm.runInNewContext(readFileSync(join(__dirname, 'voice-preload.cjs'), 'utf8'), {
    require: () => ({
      ipcRenderer: {
        on: (_channel, callback) => {
          listener = callback;
        },
        send: (...args) => sent.push(args),
        invoke: async () => ({ kind: 'answer', sdp: 'trusted-answer' }),
      },
    }),
    HostVoice: Voice,
  });
  listener({}, 1, { kind: 'audio.connect', mode: 'receive_only', microphoneMuted: false, speakerMuted: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(JSON.stringify(offerOptions)).microphone, 'none');
  assert.equal(microphoneCommands, 0);
  listener({}, 2, { kind: 'audio.microphone', muted: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), [
    'companion:voice-reply',
    2,
    { kind: 'error', code: 'permission_required' },
  ]);
});
