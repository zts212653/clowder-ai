const { isAllowedRendererLink, isAllowedRendererDownload } = require('./renderer-link-policy');
const { isExpectedOrigin } = require('./update-prompt-controller');
const { safeErrorMessage, safeHost } = require('./update-network-diagnostics');

/** Keep renderer navigation policy separate from the desktop startup lifecycle. */
function installRendererNavigation({ window, appOrigin, apiOrigin, getLinkOrigins, shell, dbg }) {
  const guardAppNavigation = (event) => {
    if (event.isMainFrame === false || isExpectedOrigin(event.url, appOrigin)) return;
    event.preventDefault();
    dbg(`Blocked renderer navigation outside app origin: ${safeHost(event.url)}`);
  };
  window.webContents.on('will-navigate', (event) => {
    if (event.isMainFrame !== false && isAllowedRendererDownload(event.url, apiOrigin)) {
      event.preventDefault();
      window.webContents.downloadURL(event.url);
      dbg(`Started trusted renderer download: ${safeHost(event.url)}`);
      return;
    }
    guardAppNavigation(event);
  });
  window.webContents.on('will-redirect', guardAppNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (!isAllowedRendererLink(parsed.href, getLinkOrigins())) {
        dbg(`Blocked non-HTTPS renderer link: ${parsed.protocol}`);
        return { action: 'deny' };
      }
      void shell.openExternal(url).catch((error) => dbg(`Could not open renderer link: ${safeErrorMessage(error)}`));
    } catch {
      dbg('Blocked malformed renderer link');
    }
    return { action: 'deny' };
  });
}
module.exports = { installRendererNavigation };
