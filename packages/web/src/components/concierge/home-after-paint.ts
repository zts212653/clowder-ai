export function afterPaintUntil(check: () => boolean, signal: AbortSignal, expiresAt: number): Promise<boolean> {
  return new Promise((resolve) => {
    let frame = 0;
    const finish = (value: boolean) => {
      cancelAnimationFrame(frame);
      signal.removeEventListener('abort', cancel);
      resolve(value);
    };
    const cancel = () => finish(false);
    const observe = () => {
      if (signal.aborted || Date.now() >= expiresAt) finish(false);
      else if (check()) finish(true);
      else frame = requestAnimationFrame(observe);
    };
    signal.addEventListener('abort', cancel, { once: true });
    frame = requestAnimationFrame(observe);
  });
}
