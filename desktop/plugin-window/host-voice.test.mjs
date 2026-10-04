import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostVoice as VoicePeer } from './host-voice.cjs';

test('receive-only Live prepares output without ever requesting microphone access', async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalPeer = globalThis.RTCPeerConnection;
  const originalStream = globalThis.MediaStream;
  const originalAudio = globalThis.Audio;
  let mediaCalls = 0;
  let transceiver;
  let channelLabel;
  let played = 0;
  const incoming = { kind: 'audio' };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia() {
          mediaCalls++;
          throw new Error('microphone requested');
        },
      },
    },
  });
  globalThis.RTCPeerConnection = class {
    iceGatheringState = 'complete';
    localDescription = { sdp: 'receive-only-offer' };
    addTransceiver(kind, options) {
      transceiver = { kind, ...options };
    }
    createDataChannel(label) {
      channelLabel = label;
      return {};
    }
    async createOffer() {
      return {};
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    getReceivers() {
      return [{ track: incoming }];
    }
    close() {}
  };
  globalThis.MediaStream = class {
    constructor(tracks) {
      this.tracks = tracks;
    }
  };
  globalThis.Audio = class {
    muted = false;
    async play() {
      played++;
    }
    pause() {}
  };
  try {
    const peer = new VoicePeer(() => {});
    assert.equal(await peer.offer({ microphone: 'none' }), 'receive-only-offer');
    assert.deepEqual(transceiver, { kind: 'audio', direction: 'recvonly' });
    assert.equal(channelLabel, 'oai-events');
    assert.equal(mediaCalls, 0);
    await peer.answer('answer');
    assert.equal(played, 1);
    assert.deepEqual(peer.output.srcObject.tracks, [incoming]);
    assert.equal(peer.muteMic(false), false, 'unmuting requires a new microphone-enabled connection');
    assert.equal(mediaCalls, 0);
    await peer.close();
  } finally {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    globalThis.RTCPeerConnection = originalPeer;
    globalThis.MediaStream = originalStream;
    globalThis.Audio = originalAudio;
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
    const pending = peer.offer();
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
    const offer = peer.offer();
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
