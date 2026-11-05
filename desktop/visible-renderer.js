/** Resolve only after Electron's first visible frame, not merely after loadURL. */
function showVisibleRenderer({ window, url, onVisible, signal, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeListener('ready-to-show', ready);
      window.removeListener('closed', closed);
      window.webContents.removeListener('did-fail-load', failed);
      window.webContents.removeListener('render-process-gone', gone);
      signal?.removeEventListener('abort', aborted);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const ready = () => {
      cleanup();
      try {
        signal?.throwIfAborted();
        onVisible();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    const closed = () => fail(new Error('Renderer closed before becoming visible'));
    const failed = (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame !== false) fail(new Error(`Renderer load failed (code ${code})`));
    };
    const gone = () => fail(new Error('Renderer exited before becoming visible'));
    const aborted = () => fail(signal.reason);
    const timer = setTimeout(() => fail(new Error(`Renderer did not become visible within ${timeoutMs}ms`)), timeoutMs);
    window.once('ready-to-show', ready);
    window.once('closed', closed);
    window.webContents.on('did-fail-load', failed);
    window.webContents.once('render-process-gone', gone);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) {
      aborted();
      return;
    }
    try {
      Promise.resolve(window.loadURL(url)).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}
module.exports = { showVisibleRenderer };
