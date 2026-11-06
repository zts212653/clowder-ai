const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { occupiedDesktopPorts } = require('./startup-services');

/** Resolve after the owned navigation produces its first visible frame. */
function showVisibleRenderer({ window, url, startupId, onVisible, signal, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    let webRequest;
    let verified = false;
    let conflict;
    let loadOptions;
    const startupUrl = new URL(url);
    const foreignResponse = () => occupiedDesktopPorts(`Web ${startupUrl.port}`);
    const cleanup = () => {
      clearTimeout(timer);
      webRequest?.onHeadersReceived(null);
      webRequest = null;
      window.removeListener('ready-to-show', ready);
      window.removeListener('closed', closed);
      window.webContents.removeListener('did-fail-load', failed);
      window.webContents.removeListener('render-process-gone', gone);
      signal?.removeEventListener('abort', aborted);
    };
    const fail = (error) => {
      cleanup();
      reject(conflict ?? error);
    };
    const ready = () => {
      cleanup();
      try {
        signal?.throwIfAborted();
        if (startupId && !verified) throw conflict ?? foreignResponse();
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
      if (startupId) {
        // A new navigation URL prevents an earlier launch's document from satisfying this proof.
        startupUrl.searchParams.set('__clowder_desktop_launch', randomUUID());
        webRequest = window.webContents.session.webRequest;
        webRequest.onHeadersReceived({ urls: [`${startupUrl.origin}/*`] }, (details, callback) => {
          if (details.resourceType !== 'mainFrame' || details.webContentsId !== window.webContents.id) {
            callback({});
            return;
          }
          const owned = Object.entries(details.responseHeaders ?? {}).some(
            ([name, values]) =>
              name.toLowerCase() === 'x-clowder-desktop-startup-id' && values.length === 1 && values[0] === startupId,
          );
          if (!owned) conflict = foreignResponse();
          verified = owned && details.statusCode >= 200 && details.statusCode < 300;
          callback({ cancel: !owned });
        });
        loadOptions = { extraHeaders: 'x-clowder-desktop-probe: 1\r\nCache-Control: no-cache' };
      }
      Promise.resolve(window.loadURL(startupId ? startupUrl.href : url, loadOptions)).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}
function createStartupSplash(BrowserWindow, apiOrigin) {
  const window = new BrowserWindow({
    width: 420,
    height: 320,
    frame: false,
    resizable: false,
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--cat-cafe-api-origin=${apiOrigin}`],
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.loadFile(path.join(__dirname, 'splash.html'));
  window.center();
  return window;
}

module.exports = { createStartupSplash, showVisibleRenderer };
