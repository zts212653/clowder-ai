const { randomUUID } = require('node:crypto');

/** The package surface's ephemeral, cache-less partition (moved verbatim from window.cjs).
 * This partition is only a snapshot renderer. Signalling stays on private IPC;
 * ordinary requests must never reach another Host or the Internet. */
function createSurfacePartition(session, url) {
  const partition = session.fromPartition(`companion-${randomUUID()}`, { cache: false });
  const surfaceOrigin = new URL(url).origin;
  partition.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let allowed = false;
    try {
      const target = new URL(details.url);
      allowed =
        ((target.protocol === 'http:' && target.origin === surfaceOrigin && !target.username && !target.password) ||
          (target.protocol === 'blob:' &&
            target.origin === surfaceOrigin &&
            ['image', 'media'].includes(details.resourceType)) ||
          (target.protocol === 'data:' && ['image', 'font'].includes(details.resourceType))) &&
        ['GET', 'HEAD'].includes(details.method);
    } catch {
      // Invalid and non-snapshot requests stay closed.
    }
    callback({ cancel: !allowed });
  });
  partition.on('will-download', (event) => event.preventDefault());
  return partition;
}

/** Only the panel's exact main document may be granted display capture, and only while
 * the Host controller admits it. Any other document in the partition (a living body
 * included) never receives a media permission. */
function admitSurfaceMedia(partition, { win, url, controller }) {
  partition.setPermissionCheckHandler(
    (contents, permission, origin) =>
      contents === win.webContents &&
      !win.isDestroyed() &&
      contents.getURL() === url &&
      origin === new URL(url).origin &&
      permission === 'display-capture' &&
      controller.display(permission),
  );
  partition.setPermissionRequestHandler((contents, permission, callback, details = {}) =>
    callback(
      contents === win.webContents &&
        !win.isDestroyed() &&
        contents.getURL() === url &&
        details.isMainFrame !== false &&
        controller.display(permission, details.mediaTypes),
    ),
  );
  partition.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: true });
}

/** A partition whose documents never hold media (the living body's own partition). Electron
 * grants permissions by default, so every check and request is refused explicitly. */
function refuseSurfaceMedia(partition) {
  partition.setPermissionCheckHandler(() => false);
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

module.exports = { createSurfacePartition, admitSurfaceMedia, refuseSurfaceMedia };
