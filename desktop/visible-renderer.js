const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { occupiedDesktopPorts } = require('./startup-services');

/** Resolve after the owned navigation produces its first visible frame. */
function showVisibleRenderer({ window, url, startupId, onVisible, signal, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    let webRequest;
    let navigationDebugger;
    let verified = false;
    let conflict;
    const startupUrl = new URL(url);
    const foreignResponse = () => occupiedDesktopPorts(`Web ${startupUrl.port}`);
    const cleanup = () => {
      clearTimeout(timer);
      webRequest?.onBeforeSendHeaders(null);
      webRequest?.onHeadersReceived(null);
      webRequest = null;
      if (navigationDebugger?.isAttached()) navigationDebugger.detach();
      navigationDebugger = null;
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
      if (startupId && window.webContents.getURL() === 'about:blank') return;
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
    window.on('ready-to-show', ready);
    window.once('closed', closed);
    window.webContents.on('did-fail-load', failed);
    window.webContents.once('render-process-gone', gone);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) {
      aborted();
      return;
    }
    const load = async () => {
      if (!startupId) {
        await window.loadURL(url);
        return;
      }
      // Use a new URL and bypass existing service workers for this navigation only.
      startupUrl.searchParams.set('__clowder_desktop_launch', randomUUID());
      const filter = { urls: [`${startupUrl.origin}/*`] };
      const isNavigation = (details) =>
        details.resourceType === 'mainFrame' && details.webContentsId === window.webContents.id;
      webRequest = window.webContents.session.webRequest;
      webRequest.onBeforeSendHeaders(filter, (details, callback) => {
        if (isNavigation(details)) details.requestHeaders['x-clowder-desktop-probe'] = '1';
        callback({ requestHeaders: details.requestHeaders });
      });
      webRequest.onHeadersReceived(filter, (details, callback) => {
        if (!isNavigation(details)) {
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
      const debuggerClient = window.webContents.debugger;
      debuggerClient.attach('1.3');
      navigationDebugger = debuggerClient;
      await debuggerClient.sendCommand('Network.enable');
      await debuggerClient.sendCommand('Network.setBypassServiceWorker', { bypass: true });
      if (!navigationDebugger) return;
      const { errorText } = await debuggerClient.sendCommand('Page.navigate', { url: startupUrl.href });
      if (errorText) throw new Error(errorText);
    };
    void load().catch(fail);
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
