/** rAF plus post-ResizeObserver geometry distinguishes intermediate layout from painted state. */
export async function startFlickerFrames(page) {
  await page.evaluate(() => {
    const trace = (window.__flicker = { frames: [], writes: [], events: [], phase: 'idle', frame: 0 });
    const sample = () => {
      const port = document.querySelector('[data-chat-container]');
      const textarea = document.querySelector('textarea');
      const footer = document.querySelector('[data-thread-chat-footer]');
      const last = document.querySelector('[data-thread-chat-reading-column]')?.lastElementChild;
      trace.frames.push({
        frame: ++trace.frame,
        phase: trace.phase,
        t: performance.now(),
        top: port.scrollTop,
        height: port.clientHeight,
        scrollHeight: port.scrollHeight,
        gap: port.scrollHeight - port.clientHeight - port.scrollTop,
        lastY: last?.getBoundingClientRect().y,
        textarea: textarea.offsetHeight,
        footerY: footer.getBoundingClientRect().y,
        works: document.querySelector('[data-testid="header-works"]').textContent,
      });
      trace.raf = requestAnimationFrame(sample);
    };
    // rAF precedes ResizeObserver. Record the post-layout state too so the
    // assertion describes pixels at paint, not the intermediate pre-RO layout.
    trace.layouts = [];
    const observer = new ResizeObserver(() => {
      const port = document.querySelector('[data-chat-container]');
      trace.layouts.push({
        frame: trace.frame,
        phase: trace.phase,
        t: performance.now(),
        top: port.scrollTop,
        height: port.clientHeight,
        scrollHeight: port.scrollHeight,
        gap: port.scrollHeight - port.clientHeight - port.scrollTop,
      });
    });
    observer.observe(document.querySelector('[data-chat-container]'));
    observer.observe(document.querySelector('[data-thread-chat-reading-column]'));
    trace.observer = observer;
    const native = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      trace.writes.push({
        frame: trace.frame,
        phase: trace.phase,
        t: performance.now(),
        kind: 'scrollIntoView',
        args,
        stack: new Error().stack,
      });
      return native.apply(this, args);
    };
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(Element.prototype, 'scrollTop', {
      ...descriptor,
      set(value) {
        if (this.matches('[data-chat-container]'))
          trace.writes.push({
            frame: trace.frame,
            phase: trace.phase,
            t: performance.now(),
            kind: 'scrollTop',
            from: this.scrollTop,
            to: value,
            stack: new Error().stack,
          });
        descriptor.set.call(this, value);
      },
    });
    document
      .querySelector('[data-chat-container]')
      .addEventListener('scroll', () => trace.events.push({ frame: trace.frame, phase: trace.phase, kind: 'scroll' }));
    sample();
  });
}
