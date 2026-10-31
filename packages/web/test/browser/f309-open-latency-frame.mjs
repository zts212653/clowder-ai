/** Install one click-to-presented-frame observation in the isolated browser page. */
export function installFirstFrameProbe() {
  window.__firstFrame = null;
  document.addEventListener(
    'click',
    () => {
      const start = performance.now();
      let watched = null;
      const presented = (media) => {
        if (!media.isConnected || performance.now() - start >= 10000) return;
        const bounds = media.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) window.__firstFrame ??= performance.now() - start;
        else requestAnimationFrame(() => presented(media));
      };
      const scan = () => {
        const media = document.querySelector(
          '[data-testid="artwork-chat-preview"] img, [data-testid="artwork-chat-preview"] video',
        );
        if (media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0) {
          void media.decode().then(() => requestAnimationFrame(() => presented(media)));
        } else if (media instanceof HTMLVideoElement && media !== watched) {
          watched = media;
          media.requestVideoFrameCallback(() => {
            presented(media);
          });
        }
        if (performance.now() - start < 10000 && window.__firstFrame === null) requestAnimationFrame(scan);
      };
      requestAnimationFrame(scan);
    },
    { capture: true, once: true },
  );
}
