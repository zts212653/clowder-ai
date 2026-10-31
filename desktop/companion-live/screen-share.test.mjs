import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScreenShare } from './screen-share.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise((done) => setImmediate(done));
function fixture() {
  const picked = deferred();
  const playback = deferred();
  const states = [];
  const frames = [];
  const track = {
    label: 'Synthetic canvas',
    stops: 0,
    stop() {
      this.stops++;
    },
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { play: () => playback.promise, pause() {}, videoWidth: 1920, videoHeight: 1080 };
  const elements = {
    createElement: (kind) =>
      kind === 'video'
        ? video
        : {
            getContext: () => ({ drawImage() {} }),
            toDataURL: () => 'data:image/jpeg;base64,/9j/AA==',
          },
  };
  const api = {
    screenRequest: async () => 'selection',
    screenStart: async () => {},
    screenStop: async () => {},
    screenFrame: async (_selection, frame) => {
      frames.push(frame);
    },
  };
  const share = new ScreenShare(
    api,
    (state) => states.push(state),
    { getDisplayMedia: () => picked.promise },
    elements,
  );
  return { share, picked, playback, states, frames, track, stream, api };
}

test('stopping while the system picker is pending closes its late track', async () => {
  const f = fixture();
  const start = f.share.start();
  await flush();
  await f.share.stop();
  f.picked.resolve(f.stream);
  await start;
  assert.ok(f.track.stops > 0);
  assert.equal(f.frames.length, 0);
  assert.equal(f.states.at(-1).sharing, false);
});

test('stopping during video playback setup cannot announce sharing or publish a frame', async () => {
  const f = fixture();
  f.picked.resolve(f.stream);
  const start = f.share.start();
  await flush();
  await f.share.stop();
  f.playback.resolve();
  await start;
  assert.equal(f.frames.length, 0);
  assert.equal(
    f.states.some((state) => state.sharing),
    false,
  );
});

test('capture produces a bounded current frame and stop immediately closes its track', async () => {
  const f = fixture();
  f.picked.resolve(f.stream);
  f.playback.resolve();
  await f.share.start();
  assert.deepEqual([f.frames[0].width, f.frames[0].height], [1280, 720]);
  const stopped = deferred();
  f.api.screenStop = () => stopped.promise;
  const stop = f.share.stop();
  assert.ok(f.track.stops > 0);
  assert.equal(f.states.at(-1).sharing, false);
  stopped.resolve();
  await stop;
});

test('denied selection request settles honestly without an unhandled rejection', async () => {
  const f = fixture();
  f.api.screenRequest = async () => {
    throw new Error('voice session ended');
  };
  await f.share.start();
  assert.equal(f.states.at(-1).sharing, false);
  assert.match(f.states.at(-1).message, /voice session ended/);
});

test('pending picker gives immediate visible feedback and repeated starts do not open another request', async () => {
  const f = fixture();
  let requests = 0;
  f.api.screenRequest = async () => {
    requests++;
    return 'selection';
  };
  const first = f.share.start();
  assert.equal(f.states.at(-1).pending, true);
  const second = f.share.start();
  await flush();
  assert.equal(requests, 1);
  await f.share.stop();
  f.picked.resolve(f.stream);
  await Promise.all([first, second]);
  assert.equal(f.states.at(-1).pending, false);
});

test('sharing is announced only after the Host accepts the first frame', async () => {
  const f = fixture();
  f.picked.resolve(f.stream);
  f.playback.resolve();
  const receipt = deferred();
  f.api.screenFrame = () => receipt.promise;
  const start = f.share.start();
  await flush();
  const announcedEarly = f.states.some((state) => state.sharing);
  receipt.resolve();
  await start;
  const announcedAfter = f.states.at(-1).sharing;
  await f.share.stop();
  assert.equal(announcedEarly, false);
  assert.equal(announcedAfter, true);
});

test('Host frame rejection never reports a successful screen share', async () => {
  const f = fixture();
  f.picked.resolve(f.stream);
  f.playback.resolve();
  f.api.screenFrame = async () => {
    throw new Error('共享画面已失效');
  };
  await f.share.start();
  assert.equal(
    f.states.some((state) => state.sharing),
    false,
  );
  assert.match(f.states.at(-1).message, /共享画面已失效/);
});
