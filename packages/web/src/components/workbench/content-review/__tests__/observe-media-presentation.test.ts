import { afterEach, expect, it, vi } from 'vitest';
import { observeMediaPresentation } from '../observe-media-presentation';

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  document.body.replaceChildren();
});

function video() {
  const node = document.createElement('video');
  node.src = 'http://api.test/media/version-2';
  document.body.append(node);
  Object.defineProperties(node, {
    currentSrc: { get: () => node.src, configurable: true },
    readyState: { value: 2, configurable: true },
    videoWidth: { value: 160, configurable: true },
    videoHeight: { value: 100, configurable: true },
    seeking: { value: false, configurable: true },
  });
  let next = 0;
  const frames = new Map<number, VideoFrameRequestCallback>();
  node.requestVideoFrameCallback = vi.fn((callback) => {
    frames.set(++next, callback);
    return next;
  });
  node.cancelVideoFrameCallback = vi.fn((id) => {
    frames.delete(id);
  });
  const ready = vi.fn();
  const stop = observeMediaPresentation(node, ready);
  disposals.push(stop);
  const present = (time = node.currentTime) => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending)
      callback(0, {
        mediaTime: time,
        presentationTime: 0,
        expectedDisplayTime: 0,
        presentedFrames: 1,
        width: 160,
        height: 100,
      });
  };
  return { node, ready, present, frames, stop };
}

it('metadata, loaded data and dimensions do not claim that the browser has presented a frame', () => {
  const f = video();
  f.node.dispatchEvent(new Event('loadedmetadata'));
  f.node.dispatchEvent(new Event('loadeddata'));
  expect(f.ready.mock.calls).toEqual([[false]]);
  f.present();
  expect(f.ready).toHaveBeenLastCalledWith(true);
});
it('does not revive readiness after a media error with a late presented-frame callback', () => {
  const f = video();
  f.present();
  f.node.dispatchEvent(new Event('error'));
  expect(f.ready).toHaveBeenLastCalledWith(false);
  f.present();
  expect(f.ready).toHaveBeenLastCalledWith(false);
});
it('requires a new presented frame after requesting the same video resource again', async () => {
  const f = video();
  f.present();
  expect(f.ready).toHaveBeenLastCalledWith(true);
  const old = [...f.frames.values()][0];
  f.node.setAttribute('src', f.node.src);
  await Promise.resolve();
  expect(f.ready).toHaveBeenLastCalledWith(false);
  old(0, { mediaTime: 0, presentationTime: 0, expectedDisplayTime: 0, presentedFrames: 1, width: 160, height: 100 });
  expect(f.ready).toHaveBeenLastCalledWith(false);
  f.node.dispatchEvent(new Event('loadedmetadata'));
  expect(f.ready).toHaveBeenLastCalledWith(false);
  f.present();
  expect(f.ready).toHaveBeenLastCalledWith(true);
});
it('keeps a seek unconfirmed until a frame belongs to that new playhead', () => {
  const f = video();
  f.present();
  f.node.currentTime = 2;
  Object.defineProperty(f.node, 'seeking', { value: true, configurable: true });
  f.node.dispatchEvent(new Event('seeking'));
  expect(f.ready).toHaveBeenLastCalledWith(false);
  f.present();
  Object.defineProperty(f.node, 'seeking', { value: false, configurable: true });
  f.node.dispatchEvent(new Event('seeked'));
  expect(f.ready).toHaveBeenLastCalledWith(true);
});
it('a frame arriving before the queued seeking event can still belong to the completed seek', () => {
  const f = video();
  f.node.currentTime = 2;
  f.present();
  f.node.dispatchEvent(new Event('seeking'));
  expect(f.ready).toHaveBeenLastCalledWith(true);
});
it('rejects a late callback from a previous resource on the same DOM element', () => {
  const f = video();
  const old = [...f.frames.values()][0];
  f.stop();
  f.node.src = 'http://api.test/media/version-3';
  old(0, { mediaTime: 0, presentationTime: 0, expectedDisplayTime: 0, presentedFrames: 1, width: 160, height: 100 });
  expect(f.ready.mock.calls).toEqual([[false]]);
});
it('an unsupported presented-frame API remains unconfirmed instead of using metadata as a substitute', () => {
  const node = document.createElement('video');
  node.src = 'http://api.test/media/version-2';
  document.body.append(node);
  Object.defineProperties(node, {
    currentSrc: { get: () => node.src },
    readyState: { value: 2 },
    videoWidth: { value: 160 },
    videoHeight: { value: 100 },
  });
  const ready = vi.fn();
  disposals.push(observeMediaPresentation(node, ready));
  node.dispatchEvent(new Event('loadeddata'));
  expect(ready.mock.calls).toEqual([[false]]);
});
