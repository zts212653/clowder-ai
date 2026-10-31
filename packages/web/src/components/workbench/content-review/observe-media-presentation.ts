/** Observe decoded pixels / a presented video frame for this exact element and resource. */
export function observeMediaPresentation(
  element: HTMLImageElement | HTMLVideoElement,
  onReady: (ready: boolean) => void,
) {
  const src = element.src;
  let active = true;
  let failed = false;
  let last: boolean | undefined;
  let callback = 0;
  let generation = 0;
  let decodedGeneration = -1;
  let frame: { mediaTime: number; playhead: number } | null = null;
  const image = element instanceof HTMLImageElement;
  const current = () => active && element.isConnected && element.src === src && element.currentSrc === src;
  const publish = () => {
    const ready =
      current() &&
      !failed &&
      (image
        ? decodedGeneration === generation && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0
        : frame !== null &&
          !element.seeking &&
          element.readyState >= 2 &&
          element.videoWidth > 0 &&
          element.videoHeight > 0);
    if (ready === last) return;
    last = ready;
    onReady(ready);
  };
  const error = () => {
    failed = true;
    frame = null;
    publish();
  };
  const seeking = () => {
    if (!image && frame?.playhead !== element.currentTime && frame?.mediaTime !== element.currentTime) frame = null;
    publish();
  };
  const decodeImage = () => {
    decodedGeneration = -1;
    publish();
    if (!image || !current() || !element.complete || element.naturalWidth === 0 || typeof element.decode !== 'function')
      return;
    const observedGeneration = generation;
    void element.decode().then(
      () => {
        if (!current() || generation !== observedGeneration || failed) return;
        decodedGeneration = observedGeneration;
        publish();
      },
      () => {
        if (current() && generation === observedGeneration && element.complete) error();
      },
    );
  };
  const watchFrame = () => {
    if (image || !element.requestVideoFrameCallback) return;
    const observedGeneration = generation;
    const capture: VideoFrameRequestCallback = (_now, metadata) => {
      if (!current() || generation !== observedGeneration) return;
      frame = { mediaTime: metadata.mediaTime, playhead: element.currentTime };
      publish();
      callback = element.requestVideoFrameCallback(capture);
    };
    callback = element.requestVideoFrameCallback(capture);
  };
  const emptied = () => {
    generation++;
    if (!image && callback) element.cancelVideoFrameCallback(callback);
    frame = null;
    decodedGeneration = -1;
    publish();
    if (image) decodeImage();
    else watchFrame();
  };
  const listeners: Array<[string, () => void]> = [
    ['load', image ? decodeImage : publish],
    ['error', error],
    ['loadeddata', publish],
    ['loadedmetadata', publish],
    ['canplay', publish],
    ['seeking', seeking],
    ['seeked', publish],
    ['emptied', emptied],
    ['waiting', publish],
  ];
  for (const [event, listener] of listeners) element.addEventListener(event, listener);
  // Next/Image can request the same src again on the same node. A prior load is not evidence for that request.
  const resource = new MutationObserver(emptied);
  resource.observe(element, { attributes: true, attributeFilter: ['src', 'srcset', 'sizes'] });
  if (image) decodeImage();
  else watchFrame();
  publish();
  return () => {
    active = false;
    resource.disconnect();
    for (const [event, listener] of listeners) element.removeEventListener(event, listener);
    if (!image && callback) element.cancelVideoFrameCallback(callback);
  };
}
