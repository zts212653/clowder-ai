/* A pausable clock. Every timer in the prototype — typing, running cats, captions — waits on
 * this instead of setTimeout, so pausing really freezes the whole scene and nothing
 * advances behind the presenter's back. Runs are cancellable so skipping a scene stops
 * the old one instead of letting two scripts fight over the page. */
((root) => {
  const CANCEL = Symbol('cancelled');
  let now = 0;
  // ?speed=N runs the whole prototype N times faster; the browser test uses it.
  const speed = Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1);
  let last = null;
  let playing = true;
  const waiters = [];
  const frames = new Set();

  function flushWaiters() {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const w = waiters[i];
      if (w.run.cancelled) {
        waiters.splice(i, 1);
        w.reject(CANCEL);
      } else if (now >= w.at) {
        waiters.splice(i, 1);
        w.resolve();
      }
    }
  }

  function tick(ts) {
    if (last === null) last = ts;
    const dt = Math.min(64, ts - last);
    last = ts;
    if (playing) {
      now += dt * speed;
      flushWaiters();
      for (const f of frames) f(now, dt);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function newRun() {
    return { cancelled: false };
  }

  function wait(ms, run) {
    return new Promise((resolve, reject) => {
      if (run.cancelled) return reject(CANCEL);
      waiters.push({ at: now + ms, run, resolve, reject });
    });
  }

  /** Drive fn(k) with k from 0 to 1 over ms of clock time. */
  function tween(ms, run, fn) {
    return new Promise((resolve, reject) => {
      const start = now;
      const step = (t) => {
        if (run.cancelled) {
          frames.delete(step);
          return reject(CANCEL);
        }
        const k = Math.min(1, (t - start) / ms);
        fn(k);
        if (k >= 1) {
          frames.delete(step);
          resolve();
        }
      };
      fn(0);
      frames.add(step);
    });
  }

  function onFrame(fn) {
    frames.add(fn);
    return () => frames.delete(fn);
  }

  function setPlaying(value) {
    playing = value;
    document.body.classList.toggle('paused', !value);
  }

  const isCancel = (e) => e === CANCEL;

  root.OnbClock = {
    newRun,
    wait,
    tween,
    onFrame,
    setPlaying,
    isPlaying: () => playing,
    now: () => now,
    isCancel,
  };
})(window);
