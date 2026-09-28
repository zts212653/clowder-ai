/** Bounded browser-native event trace, retained with failure evidence; no product state is injected. */
export async function installMediaDiagnostics(page) {
  await page.addInitScript(() => {
    const events = [];
    window.__F309_MEDIA_EVENTS__ = events;
    const ids = new WeakMap();
    let nextId = 0;
    const record = (video, event, extra = {}) => {
      if (!ids.has(video)) ids.set(video, ++nextId);
      const button = [...document.querySelectorAll('button')].find(
        (item) => item.textContent.trim() === '圈出这帧画面',
      );
      events.push({
        at: performance.now(),
        video: ids.get(video),
        event,
        time: video.currentTime,
        paused: video.paused,
        seeking: video.seeking,
        readyState: video.readyState,
        connected: video.isConnected,
        frameButtonDisabled: button?.disabled,
        ...extra,
      });
      if (events.length > 500) events.shift();
    };
    for (const event of ['loadstart', 'loadedmetadata', 'loadeddata', 'seeking', 'seeked', 'play', 'pause', 'error'])
      document.addEventListener(
        event,
        (event) => {
          if (event.target instanceof HTMLVideoElement) record(event.target, event.type);
        },
        true,
      );
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      record(this, 'request-frame');
      return original.call(this, (now, metadata) => {
        record(this, 'presented-frame', { mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames });
        callback(now, metadata);
      });
    };
    const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      ...time,
      set(value) {
        if (this instanceof HTMLVideoElement)
          record(this, 'set-current-time', {
            target: value,
            caller: new Error().stack?.split('\n').slice(1, 5).join('\n'),
          });
        time.set.call(this, value);
      },
    });
  });
}

export function readMediaDiagnostics(page) {
  return page.evaluate(() => ({
    events: window.__F309_MEDIA_EVENTS__ ?? [],
    buttons: [...document.querySelectorAll('button')].map((button) => ({
      text: button.textContent.trim(),
      disabled: button.disabled,
    })),
    videos: [...document.querySelectorAll('video')].map((video) => ({
      time: video.currentTime,
      paused: video.paused,
      seeking: video.seeking,
      readyState: video.readyState,
      error: video.error?.code ?? null,
    })),
  }));
}
