import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostVoice } from './host-voice.cjs';

test('a fulfilled play call, mute, zero energy and a stopped clock do not prove nonzero audio output', async () => {
  const events = [];
  const peer = new HostVoice((event) => events.push(event));
  let energy = 0;
  peer.outputTurnId = 'assistant-turn';
  peer.output = { muted: false, volume: 1, paused: false, currentTime: 0, pause() {} };
  peer.pc = {
    getStats: async () =>
      new Map([
        [
          'audio',
          { id: 'audio', type: 'inbound-rtp', kind: 'audio', bytesReceived: energy * 100, totalAudioEnergy: energy },
        ],
      ]),
    close() {},
  };
  const sample = () => peer.samplePlayback?.();
  await sample();
  peer.output.currentTime = 1;
  await sample();
  assert.equal(events.length, 0);
  energy = 1;
  await sample();
  assert.equal(events.length, 0, 'energy with a stationary media clock stays unobserved');
  peer.output.muted = true;
  peer.output.currentTime = 2;
  energy = 2;
  await sample();
  assert.equal(events.length, 0);
  peer.output.muted = false;
  peer.output.currentTime = 3;
  energy = 3;
  await sample();
  assert.equal(events.length, 1, 'first nonzero unmuted output is a separate endpoint');
  assert.equal(events[0].stage, 'first_audio_output');
  assert.equal(events[0].turnId, 'assistant-turn');
  peer.output.currentTime = 4;
  energy = 4;
  await sample();
  assert.equal(events.length, 1, 'the same output turn reports once');
  await peer.close();
  await sample();
  assert.equal(events.length, 1);
});

test('an in-flight stats response after close cannot publish playback', async () => {
  const events = [];
  const peer = new HostVoice((event) => events.push(event));
  let resolveStats;
  peer.outputTurnId = 'old-turn';
  peer.output = { muted: false, volume: 1, paused: false, currentTime: 1, pause() {} };
  peer.pc = {
    getStats: () =>
      new Promise((resolve) => {
        resolveStats = resolve;
      }),
    close() {},
  };
  const sampling = peer.samplePlayback?.();
  await peer.close();
  resolveStats?.(
    new Map([['audio', { id: 'audio', type: 'inbound-rtp', kind: 'audio', bytesReceived: 100, totalAudioEnergy: 1 }]]),
  );
  await sampling;
  assert.equal(events.length, 0);
});
