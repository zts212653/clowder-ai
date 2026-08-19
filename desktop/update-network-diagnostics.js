// F273: safe observability for Electron's default system-proxy download path.

const DIAGNOSTIC_TIMEOUT_MS = 5_000;

function bounded(promise, timeoutMs = DIAGNOSTIC_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('proxy diagnostic timeout')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function safeErrorMessage(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
}

function safeHost(url) {
  try {
    return new URL(url).hostname || 'unknown-host';
  } catch {
    return 'invalid-url';
  }
}

async function diagnoseProxy(session, url, dbg) {
  if (!session?.forceReloadProxyConfig || !session?.resolveProxy) return;
  try {
    await bounded(Promise.resolve(session.forceReloadProxyConfig()));
    const proxy = await bounded(Promise.resolve(session.resolveProxy(url)));
    const safeProxy = String(proxy || 'DIRECT')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 500);
    dbg(`Download proxy: ${safeProxy}`);
  } catch (error) {
    dbg(`Proxy diagnostics unavailable: ${safeErrorMessage(error)}`);
  }
}

function attachRedirectDiagnostics(request, dbg) {
  request.on('redirect', (statusCode, method, redirectUrl) => {
    const safeMethod = String(method || 'GET')
      .replace(/[^A-Z]/gi, '')
      .slice(0, 12);
    dbg(`Redirect ${Number(statusCode) || 0} ${safeMethod || 'GET'} -> ${safeHost(redirectUrl)}`);
    // Electron cancels a redirect when a listener exists unless it is followed
    // synchronously from inside this event.
    request.followRedirect();
  });
}

module.exports = {
  attachRedirectDiagnostics,
  diagnoseProxy,
  safeErrorMessage,
  safeHost,
};
