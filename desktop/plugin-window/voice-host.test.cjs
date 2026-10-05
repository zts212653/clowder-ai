const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createVoiceHost } = require('./voice-host.cjs');

function fixture({
  load = async () => {},
  beforeReply = () => {},
  callScoped = false,
  beforeOffer = async () => {},
  answerCallId = 'ec6f640a-6dd7-46fc-9c09-3f3c47ecbd97',
} = {}) {
  const handlers = new Map(),
    windows = [],
    partitions = [],
    events = [];
  let armed = false,
    offers = 0,
    failed = 0;
  const ipcMain = Object.assign(new EventEmitter(), {
    handle: (name, fn) => handlers.set(name, fn),
    removeHandler: (name) => handlers.delete(name),
  });
  class Window extends EventEmitter {
    constructor(options) {
      super();
      windows.push(this);
      this.options = options;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        getURL: () => this.url,
        mainFrame: {},
        setWindowOpenHandler() {},
        send: (_channel, id, command) => {
          this.commands ??= [];
          this.commands.push(command);
          queueMicrotask(() => {
            beforeReply(this, ipcMain);
            ipcMain.emit('companion:voice-reply', this.event(), id, { kind: 'ok' });
          });
        },
      });
    }
    event() {
      return { sender: this.webContents, senderFrame: this.webContents.mainFrame };
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
    async loadURL(url) {
      this.url = url;
      this.webContents.mainFrame.url = url;
      await load();
    }
  }
  const host = createVoiceHost(
    {
      BrowserWindow: Window,
      ipcMain,
      session: {
        fromPartition: () => {
          const p = Object.assign(new EventEmitter(), {
            setPermissionCheckHandler(fn) {
              this.check = fn;
            },
            setPermissionRequestHandler(fn) {
              this.request = fn;
            },
            setDisplayMediaRequestHandler(fn) {
              this.display = fn;
            },
            webRequest: { onBeforeRequest() {} },
          });
          partitions.push(p);
          return p;
        },
      },
    },
    {
      resources: { voiceUrl: 'file:///fixture/host-voice.html', voicePreload: '/fixture/host-preload.cjs' },
      isArmed: () => armed,
      callScoped,
      publish: (value) => events.push(value),
      requestOffer: async () => {
        offers++;
        await beforeOffer();
        return { kind: 'answer', sdp: 'trusted', callId: answerCallId };
      },
      onFailure: () => failed++,
    },
  );
  return {
    host,
    handlers,
    ipcMain,
    windows,
    partitions,
    events,
    setArmed() {
      armed = true;
    },
    arm() {
      armed = true;
      host.prepare(Promise.resolve({ kind: 'state', phase: 'ready' }));
    },
    get offers() {
      return offers;
    },
    get failed() {
      return failed;
    },
  };
}

test('modern audio events bind the Host-issued call, ignore a forged event scope and fence the retired document', async (t) => {
  const f = fixture({ callScoped: true });
  t.after(() => f.host.close());
  f.arm();
  await f.host.request({ kind: 'audio.connect' }, true);
  const win = f.windows[0];
  f.ipcMain.emit('companion:voice-event', win.event(), { kind: 'audio', type: 'transcript', callId: 'forged' });
  assert.equal(f.events.length, 0, 'no audio source precedes a Host-issued call');
  await f.handlers.get('companion:media-offer')(win.event(), 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');
  for (const type of ['transcript', 'recovering', 'error']) {
    f.ipcMain.emit('companion:voice-event', win.event(), { kind: 'audio', type, callId: 'forged' });
    assert.equal(f.events.at(-1).callId, 'ec6f640a-6dd7-46fc-9c09-3f3c47ecbd97');
  }
  f.host.stop();
  f.arm();
  await f.host.request({ kind: 'audio.connect' }, true);
  f.ipcMain.emit('companion:voice-event', win.event(), { kind: 'audio', type: 'error' });
  assert.equal(f.events.length, 3, 'a retired sender cannot poison the new call');
});

test('a late answer from an old preparation cannot bind events in the new document', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({ callScoped: true, beforeOffer: () => pending });
  t.after(() => f.host.close());
  f.arm();
  await f.host.request({ kind: 'audio.connect' }, true);
  const signal = f.handlers.get('companion:media-offer');
  const answer = signal(f.windows[0].event(), 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n');
  f.arm();
  await f.host.request({ kind: 'audio.connect' }, true);
  release();
  assert.equal((await answer).code, 'cancelled');
  f.ipcMain.emit('companion:voice-event', f.windows[1].event(), { kind: 'audio', type: 'transcript' });
  assert.deepEqual(f.events, []);
});

test('modern signalling refuses an answer without an actual call identity', async (t) => {
  const f = fixture({ callScoped: true, answerCallId: 'not-a-call' });
  t.after(() => f.host.close());
  f.arm();
  await f.host.request({ kind: 'audio.connect' }, true);
  const win = f.windows[0];
  assert.equal(
    (await f.handlers.get('companion:media-offer')(win.event(), 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n')).code,
    'unavailable',
  );
  f.ipcMain.emit('companion:voice-event', win.event(), { kind: 'audio', type: 'recovering' });
  assert.deepEqual(f.events, []);
});

test('only the fixed Host media document gets audio permission and private signalling', async (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  assert.equal((await f.host.request({ kind: 'audio.connect' }, true)).code, 'permission_required');
  assert.equal(f.windows.length, 0);
  await f.host.request({ kind: 'audio.microphone', muted: true });
  f.arm();
  assert.equal((await f.host.request({ kind: 'audio.connect' }, true)).kind, 'ok');
  assert.equal((await f.host.request({ kind: 'audio.connect' }, true)).code, 'permission_required');
  const window = f.windows[0],
    partition = f.partitions[0];
  assert.equal(window.options.show, false);
  assert.equal(window.commands[0].microphoneMuted, true);
  const permitted = (contents, mediaTypes) => {
    let result;
    partition.request(contents, 'media', (value) => (result = value), { mediaTypes });
    return result;
  };
  assert.equal(permitted(window.webContents, ['audio']), true);
  assert.equal(permitted(window.webContents, ['video']), false);
  assert.equal(permitted({ getURL: () => window.url }, ['audio']), false);
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  const signal = f.handlers.get('companion:media-offer');
  assert.equal(
    (await signal({ sender: {}, senderFrame: window.webContents.mainFrame }, sdp)).code,
    'permission_required',
  );
  assert.equal((await signal(window.event(), sdp)).kind, 'answer');
  assert.equal(f.offers, 1);
  await f.host.request({ kind: 'audio.close' });
  assert.equal(window.destroyed, true);
  assert.equal(permitted(window.webContents, ['audio']), false);
  assert.equal((await signal(window.event(), sdp)).code, 'permission_required');
  f.ipcMain.emit('companion:voice-event', window.event(), { kind: 'audio', type: 'connected' });
  assert.equal(f.events.length, 0);
});

test('ready preparation alone cannot authorize an inactive delayed audio connection', async (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  f.arm();
  await new Promise((resolve) => setImmediate(resolve));
  const reply = await f.host.request({ kind: 'audio.connect' }, false);
  assert.equal(reply.code, 'permission_required');
  assert.equal(f.windows.length, 0, 'no Host media document or getUserMedia can be created');
});

test('receive-only connection keeps microphone permission unavailable for its entire generation', async (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  f.arm();
  assert.equal((await f.host.request({ kind: 'audio.connect', mode: 'receive_only' }, true)).kind, 'ok');
  assert.equal(f.host.mode(), 'receive_only');
  assert.equal(f.windows[0].commands[0].mode, 'receive_only');
  const window = f.windows[0];
  let permitted;
  f.partitions[0].request(
    window.webContents,
    'media',
    (value) => {
      permitted = value;
    },
    {
      mediaTypes: ['audio'],
    },
  );
  assert.equal(permitted, false);
  assert.equal((await f.host.request({ kind: 'audio.microphone', muted: false })).code, 'permission_required');
  assert.equal(window.commands.length, 1, 'no private unmute command reaches the media document');
  f.ipcMain.emit('companion:voice-event', window.event(), { kind: 'audio', type: 'error' });
  assert.equal(f.host.mode(), null, 'a failed media path is not reported as active');
  f.partitions[0].request(
    window.webContents,
    'media',
    (value) => {
      permitted = value;
    },
    {
      mediaTypes: ['audio'],
    },
  );
  assert.equal(permitted, false, 'media failure does not restore capture authority');
  assert.equal((await f.host.request({ kind: 'audio.microphone', muted: false })).code, 'permission_required');
  await f.host.request({ kind: 'audio.close' });
  assert.equal(f.host.mode(), null);
});

test('invalid audio mode cannot consume preparation or open a media document', async (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  f.arm();
  assert.equal((await f.host.request({ kind: 'audio.connect', mode: 'capture' }, true)).code, 'invalid_request');
  assert.equal(f.windows.length, 0);
  assert.equal((await f.host.request({ kind: 'audio.connect' }, true)).kind, 'ok');
  assert.equal(f.host.mode(), 'duplex');
  assert.equal(Object.hasOwn(f.windows[0].commands[0], 'mode'), false);
});

test('an early media failure cannot be overwritten by a late successful command reply', async (t) => {
  const f = fixture({
    beforeReply(window, ipcMain) {
      ipcMain.emit('companion:voice-event', window.event(), { kind: 'audio', type: 'error' });
    },
  });
  t.after(() => f.host.close());
  f.arm();
  assert.equal((await f.host.request({ kind: 'audio.connect', mode: 'receive_only' }, true)).code, 'unavailable');
  assert.equal(f.host.mode(), null);
});

test('stopping during Host voice startup destroys the old principal and fences its late completion', async (t) => {
  let ready;
  const load = new Promise((resolve) => (ready = resolve));
  const f = fixture({ load: () => load });
  t.after(() => f.host.close());
  f.arm();
  const connecting = f.host.request({ kind: 'audio.connect' }, true);
  await new Promise((resolve) => setImmediate(resolve));
  const old = f.windows[0];
  await f.host.request({ kind: 'audio.close' });
  ready();
  assert.equal((await connecting).kind, 'error');
  assert.equal(old.destroyed, true);
  assert.equal(old.commands, undefined);
  assert.equal(f.failed, 0, 'intentional teardown does not report a crash');
  f.arm();
  assert.equal((await f.host.request({ kind: 'audio.connect' }, true)).kind, 'ok');
  f.windows[1].webContents.emit('render-process-gone');
  assert.equal(f.failed, 1);
  assert.equal(f.windows[1].destroyed, true);
});

test('a current gesture submits once before ready, and Host alone waits for preparation', async (t) => {
  let ready;
  const preparation = new Promise((resolve) => (ready = resolve));
  const f = fixture();
  t.after(() => f.host.close());
  f.host.prepare(preparation);
  const connecting = f.host.request({ kind: 'audio.connect' }, true);
  assert.equal(f.windows.length, 0);
  assert.equal((await f.host.request({ kind: 'audio.connect' }, true)).code, 'permission_required');
  f.setArmed();
  ready({ kind: 'state', phase: 'ready' });
  assert.equal((await connecting).kind, 'ok');
  assert.equal(f.windows.length, 1);
});

test('close cancels a pre-ready connection and a late ready cannot create media', async (t) => {
  let ready;
  const preparation = new Promise((resolve) => (ready = resolve));
  const f = fixture();
  t.after(() => f.host.close());
  f.host.prepare(preparation);
  const connecting = f.host.request({ kind: 'audio.connect' }, true);
  await f.host.request({ kind: 'audio.close' });
  assert.equal((await connecting).code, 'cancelled');
  f.setArmed();
  ready({ kind: 'state', phase: 'ready' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.windows.length, 0);
  assert.equal((await f.host.request({ kind: 'audio.connect' }, true)).code, 'permission_required');
});

test('a newer preparation invalidates the old click and waiting for ready has a Host deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finishOld;
  const old = new Promise((resolve) => (finishOld = resolve));
  const f = fixture();
  t.after(() => f.host.close());
  f.host.prepare(old);
  const oldConnect = f.host.request({ kind: 'audio.connect' }, true);
  f.host.prepare(new Promise(() => {}));
  assert.equal((await oldConnect).code, 'cancelled');
  finishOld({ kind: 'state', phase: 'ready' });
  const pending = f.host.request({ kind: 'audio.connect' }, true);
  t.mock.timers.tick(60000);
  assert.equal((await pending).code, 'cancelled');
  assert.equal(f.windows.length, 0);
  assert.equal(f.failed, 1);
});
