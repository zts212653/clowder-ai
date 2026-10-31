export const CSSOM_FINAL_PROOF_RACE_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      html, body { height: 100%; margin: 0; overflow: hidden; }
      p { margin: 8px; }
    </style>
    <style id="post-proof-cssom-paint"></style>
  </head>
  <body>
    <p>Paint inserted after the final pre-capture proof must invalidate the candidate screenshot.</p>
  </body>
</html>`;

export const CSSOM_FIXED_ROOT_PSEUDO_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      html, body { height: 100%; margin: 0; overflow: hidden; }
      p { margin: 8px; }
    </style>
    <style id="late-cssom-paint"></style>
  </head>
  <body>
    <p>CSSOM-generated fixed paint must revoke export readiness.</p>
    <script>
      setTimeout(() => {
        document.querySelector('#late-cssom-paint').sheet.insertRule(
          'html::after { content: "CSSOM_FIXED_ROOT_PSEUDO_SENTINEL"; position: fixed; top: 1000px; height: 1000px; width: 100%; background: #ff00ff; }'
        );
      }, 450);
    </script>
  </body>
</html>`;

export const CSSOM_ROOT_PSEUDO_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; overflow: hidden; }
      p { margin: 8px; }
    </style>
    <style id="proof-bound-cssom-flow"></style>
    <script>
      (() => {
        const fixtureMode = 'cssom-root-pseudo-content';
        const widgetId = 'cssom-root-pseudo-content-widget';
        const emit = (phase, proofRequestId, extra = {}) => parent.postMessage({
          type: 'cat-cafe:f294-fixture-trace',
          v: 1,
          fixtureMode,
          widgetId,
          phase,
          proofRequestId,
          monotonicMs: performance.now(),
          ...extra
        }, '*');
        let handled = false;
        window.addEventListener('message', (event) => {
          const request = event.data;
          const proofRequestId = request?.proofRequestId;
          if (
            handled ||
            event.source !== parent ||
            !request ||
            request.type !== 'cat-cafe:html-widget-proof-request' ||
            request.v !== 6 ||
            request.blockId !== widgetId ||
            typeof request.instanceId !== 'string' ||
            typeof proofRequestId !== 'string' ||
            proofRequestId.length < 1 ||
            proofRequestId.length > 128 ||
            !/^[A-Za-z0-9:_-]+$/.test(proofRequestId)
          ) return;
          handled = true;
          // The CSSOM write happens inside the same message turn in which the
          // bridge schedules its double-RAF plus 100ms fallback measurement.
          // Delay only those first scheduling calls, without reading layout,
          // so CSS/ResizeObserver invalidation is ordered before the fresh ACK.
          const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
          const nativeSetTimeout = window.setTimeout.bind(window);
          let remainingRafDelays = 2;
          window.requestAnimationFrame = (callback) => {
            const delayIndex = 3 - remainingRafDelays;
            remainingRafDelays -= 1;
            emit('flow-raf-delay-applied', proofRequestId, { delayIndex, appliedDelayMs: 175 });
            if (remainingRafDelays === 0) window.requestAnimationFrame = nativeRequestAnimationFrame;
            return nativeSetTimeout(() => nativeRequestAnimationFrame(callback), 175);
          };
          let delayTimerFallback = true;
          window.setTimeout = (callback, delay = 0, ...args) => {
            if (delayTimerFallback && delay === 100) {
              delayTimerFallback = false;
              window.setTimeout = nativeSetTimeout;
              emit('flow-timer-delay-applied', proofRequestId, {
                requestedDelayMs: 100,
                appliedDelayMs: 400
              });
              return nativeSetTimeout(callback, 400, ...args);
            }
            return nativeSetTimeout(callback, delay, ...args);
          };
          emit('mutation-attempted', proofRequestId);
          try {
            const sheet = document.querySelector('#proof-bound-cssom-flow')?.sheet;
            if (!sheet) throw new Error('proof-bound stylesheet unavailable');
            sheet.insertRule(
              'html::after { content: "CSSOM_ROOT_PSEUDO_SENTINEL"; display: block; height: 1000px; background: #ff00ff; }'
            );
            emit('mutation-succeeded', proofRequestId);
          } catch (error) {
            emit('mutation-failed', proofRequestId, { mutationError: String(error).slice(0, 256) });
          }
        }, true);
      })();
    </script>
  </head>
  <body><p>Measurable CSSOM-generated flow must refresh and remain exportable.</p></body>
</html>`;

export const DELAYED_PROOF_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>html, body { margin: 0; } p { margin: 8px; }</style>
    <script>
      (() => {
        const fixtureMode = 'delayed-proof';
        const widgetId = 'delayed-proof-widget';
        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        const nativeSetTimeout = window.setTimeout.bind(window);
        const emit = (phase, proofRequestId, extra = {}) => parent.postMessage({
          type: 'cat-cafe:f294-fixture-trace',
          v: 1,
          fixtureMode,
          widgetId,
          phase,
          proofRequestId,
          monotonicMs: performance.now(),
          ...extra
        }, '*');
        let handled = false;
        window.addEventListener('message', (event) => {
          const request = event.data;
          const proofRequestId = request?.proofRequestId;
          if (
            handled ||
            event.source !== parent ||
            !request ||
            request.type !== 'cat-cafe:html-widget-proof-request' ||
            request.v !== 6 ||
            request.blockId !== widgetId ||
            typeof proofRequestId !== 'string' ||
            !/^[A-Za-z0-9:_-]{1,128}$/.test(proofRequestId)
          ) return;
          handled = true;
          let remainingRafDelays = 2;
          window.requestAnimationFrame = (callback) => {
            const delayIndex = 3 - remainingRafDelays;
            remainingRafDelays -= 1;
            emit('raf-delay-applied', proofRequestId, { delayIndex, appliedDelayMs: 1100 });
            if (remainingRafDelays === 0) window.requestAnimationFrame = nativeRequestAnimationFrame;
            return nativeSetTimeout(() => nativeRequestAnimationFrame(callback), 1100);
          };
          let delayTimerFallback = true;
          window.setTimeout = (callback, delay = 0, ...args) => {
            if (delayTimerFallback && delay === 100) {
              delayTimerFallback = false;
              window.setTimeout = nativeSetTimeout;
              emit('timer-fallback-delay-applied', proofRequestId, {
                requestedDelayMs: 100,
                appliedDelayMs: 2300
              });
              return nativeSetTimeout(callback, 2300, ...args);
            }
            return nativeSetTimeout(callback, delay, ...args);
          };
          emit('proof-delay-armed', proofRequestId);
        }, true);
      })();
    </script>
  </head>
  <body><p>Both proof scheduling paths must tolerate a bounded delay.</p></body>
</html>`;
