import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoicePeer } from './peer.mjs';

test('synthetic evidence stops recording after one minute and retains the bounded clip until close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = new Map(['MediaStream', 'Audio', 'MediaRecorder'].map((key) => [key, globalThis[key]]));
  let recorder;
  globalThis.MediaStream = class {};
  globalThis.Audio = class {
    async play() {}
    pause() {}
  };
  globalThis.MediaRecorder = class {
    state = 'inactive';
    constructor() {
      recorder = this;
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['synthetic-audio']) });
      this.onstop?.();
    }
  };
  try {
    const peer = new VoicePeer(() => {});
    peer.synthetic = true;
    peer.pc = { async setRemoteDescription() {}, getReceivers: () => [{ track: { kind: 'audio' } }], close() {} };
    await peer.answer('synthetic-answer');
    t.mock.timers.tick(60_000);
    assert.equal(recorder.state, 'inactive');
    t.mock.timers.tick(600_000);
    assert.equal(Buffer.from(await peer.close(), 'base64').toString(), 'synthetic-audio');
  } finally {
    for (const [key, value] of saved) globalThis[key] = value;
  }
});

test('microphone muted during permission wait stays muted before being attached', async () => {
  let grant;
  let attachedEnabled;
  const track = { enabled: true, stop() {} };
  const originalAudio = globalThis.AudioContext;
  const originalPeer = globalThis.RTCPeerConnection;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.AudioContext = class {
    async resume() {}
    async close() {}
  };
  globalThis.RTCPeerConnection = class {
    iceGatheringState = 'complete';
    localDescription = { sdp: 'offer' };
    addTrack(value) {
      attachedEnabled = value.enabled;
    }
    createDataChannel() {
      return {};
    }
    async createOffer() {
      return {};
    }
    async setLocalDescription() {}
    close() {}
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    },
  });
  try {
    const peer = new VoicePeer(() => {});
    const pending = peer.offer(false);
    await Promise.resolve();
    peer.muteMic(true);
    grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    await pending;
    assert.equal(attachedEnabled, false);
    await peer.close();
  } finally {
    globalThis.AudioContext = originalAudio;
    globalThis.RTCPeerConnection = originalPeer;
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  }
});

test('speaker muted before SDP stays muted before playback begins', async () => {
  const originalStream = globalThis.MediaStream;
  const originalAudio = globalThis.Audio;
  let mutedWhenPlayed;
  globalThis.MediaStream = class {};
  globalThis.Audio = class {
    muted = false;
    async play() {
      mutedWhenPlayed = this.muted;
    }
    pause() {}
  };
  try {
    const peer = new VoicePeer(() => {});
    peer.pc = { async setRemoteDescription() {}, getReceivers: () => [{ track: { kind: 'audio' } }], close() {} };
    peer.muteSpeaker(true);
    await peer.answer('answer');
    assert.equal(mutedWhenPlayed, true);
    await peer.close();
  } finally {
    globalThis.MediaStream = originalStream;
    globalThis.Audio = originalAudio;
  }
});

test('ending while the microphone picker is open stops any late-granted stream', async () => {
  let grant;
  let stops = 0;
  const originalAudio = globalThis.AudioContext;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.AudioContext = class {
    async resume() {}
    async close() {}
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    },
  });
  try {
    const peer = new VoicePeer(() => {});
    const offer = peer.offer(false);
    await Promise.resolve();
    await peer.close();
    grant({
      getTracks: () => [
        {
          stop() {
            stops++;
          },
        },
      ],
    });
    await assert.rejects(offer, /已结束/);
    assert.equal(stops, 1);
  } finally {
    globalThis.AudioContext = originalAudio;
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  }
});

test('muting speaker preserves microphone; ending stops the track and connection', async () => {
  let trackStops = 0;
  let peerCloses = 0;
  const track = {
    enabled: true,
    stop() {
      trackStops++;
    },
  };
  const peer = new VoicePeer(() => {});
  peer.stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  peer.pc = {
    close() {
      peerCloses++;
    },
  };
  peer.output = { muted: false, pause() {}, srcObject: {} };
  peer.muteSpeaker(true);
  assert.equal(track.enabled, true);
  peer.muteMic(true);
  assert.equal(track.enabled, false);
  assert.equal(peer.output.muted, true);
  await peer.close();
  assert.equal(trackStops, 1);
  assert.equal(peerCloses, 1);
  assert.equal(peer.output.srcObject, null);
});

test('brief disconnection preserves the session and recovery cancels the deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const peer = new VoicePeer((event) => events.push(event));
  peer.pc = { connectionState: 'disconnected' };
  peer.connectionChanged();
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
  assert.equal(
    events.some((event) => event.type === 'recovering'),
    true,
  );
  t.mock.timers.tick(3000);
  peer.pc.connectionState = 'connected';
  peer.connectionChanged();
  assert.equal(
    events.some((event) => event.type === 'recovered'),
    true,
  );
  t.mock.timers.tick(10000);
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
});

test('persistent disconnect and failed transport give distinct terminal reasons', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const peer = new VoicePeer((event) => events.push(event));
  peer.pc = { connectionState: 'disconnected' };
  peer.connectionChanged();
  t.mock.timers.tick(7999);
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
  t.mock.timers.tick(1);
  assert.equal(events.find((event) => event.type === 'error')?.reason, 'disconnect-timeout');
  const failed = new VoicePeer((event) => events.push(event));
  failed.pc = { connectionState: 'failed' };
  failed.connectionChanged();
  assert.equal(events.at(-1).reason, 'transport-failed');
});

test('ending during recovery cancels the timer and ignores late connection events', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const peer = new VoicePeer((event) => events.push(event));
  peer.pc = { connectionState: 'disconnected', close() {} };
  peer.connectionChanged();
  await peer.close();
  events.length = 0;
  t.mock.timers.tick(10000);
  peer.pc.connectionState = 'connected';
  peer.connectionChanged();
  assert.deepEqual(events, []);
});
