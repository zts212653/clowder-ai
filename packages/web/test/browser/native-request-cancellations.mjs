import { randomUUID } from 'node:crypto';

// Observe the caller's actual AbortSignal; do not replace responses, promises,
// signals or request headers. A URL allowlist cannot prove an expected cancel.
function installFetchObserver(binding) {
  const key = `__${binding}`;
  if (window[key]) return;
  const original = window.fetch;
  const wrapper = function (input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const startedAt = Date.now();
    const canceled = () => {
      try {
        window[binding](
          JSON.stringify({
            method: method.toUpperCase(),
            path: url.pathname,
            startedAt,
            failedAt: Date.now(),
          }),
        );
      } catch {}
    };
    if (signal?.aborted) canceled();
    else signal?.addEventListener('abort', canceled, { once: true });
    return original.call(this, input, init);
  };
  window[key] = { original, wrapper };
  window.fetch = wrapper;
}

export async function observeCallerCancellations(page, record, session) {
  record.callerCancellations = [];
  record.browserRequestFailures = [];
  const binding = `nativeCancel_${randomUUID().replaceAll('-', '')}`;
  await session.send('Runtime.enable');
  await session.send('Runtime.addBinding', { name: binding });
  session.on('Runtime.bindingCalled', (event) => {
    if (event.name === binding) record.callerCancellations.push(JSON.parse(event.payload));
  });
  const script = await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(${installFetchObserver.toString()})(${JSON.stringify(binding)})`,
  });
  await page.evaluate(installFetchObserver, binding);
  const failed = (request) => {
    record.browserRequestFailures.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      resourceType: request.resourceType(),
      prefetch: isPrefetch(request.headers()),
      startedAt: request.timing().startTime,
      failedAt: Date.now(),
      failure: request.failure()?.errorText,
    });
  };
  page.on('requestfailed', failed);
  return async () => {
    page.off('requestfailed', failed);
    await page.evaluate((binding) => {
      const key = `__${binding}`,
        observer = window[key];
      if (observer && window.fetch === observer.wrapper) window.fetch = observer.original;
      delete window[key];
    }, binding);
    await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
    await session.send('Runtime.removeBinding', { name: binding });
  };
}

export function isPrefetch(headers) {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return lower['next-router-prefetch'] === '1' || /\bprefetch\b/i.test(lower.purpose ?? lower['sec-purpose'] ?? '');
}

export function callerCancellation(error, record) {
  if (!error.canceled || error.failure !== 'net::ERR_ABORTED') return null;
  let request = error;
  if (!request.path) {
    const matches = (record.browserRequestFailures ?? []).filter(
      (item) => item.failure === error.failure && Math.abs(item.failedAt - error.failedAt) < 50,
    );
    if (matches.length !== 1) return null;
    request = {
      ...matches[0],
      ...error,
      method: matches[0].method,
      path: matches[0].path,
      startedAt: matches[0].startedAt,
    };
  }
  if (request.prefetch) return { kind: 'prefetch', request };
  const callers = (record.callerCancellations ?? []).filter(
    (item) =>
      item.method === request.method &&
      item.path === request.path &&
      Math.abs(item.startedAt - request.startedAt) < 250 &&
      Math.abs(item.failedAt - request.failedAt) < 1000,
  );
  return callers.length === 1 ? { kind: 'caller-abort-signal', request, caller: callers[0] } : null;
}

export function verifiedRscCancellation(error, record) {
  if (
    !error.canceled ||
    error.failure !== 'net::ERR_ABORTED' ||
    error.method !== 'GET' ||
    !error.rsc ||
    error.responseStatus !== 200 ||
    error.mimeType !== 'text/x-component' ||
    error.fromServiceWorker !== true
  )
    return false;
  return (
    record.verifiedRoutes?.some(
      (route) =>
        route.path === error.path &&
        route.document === error.document &&
        route.frameId === error.frameId &&
        Number.isFinite(route.verifiedAt) &&
        route.verifiedAt >= error.failedAt,
    ) === true
  );
}
