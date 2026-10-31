// Desktop popup policy. Electron-created child windows stay denied; this
// predicate decides whether the URL may be handed to the system browser.

const DESKTOP_VERSION_PARAM = '__clowder_desktop_version';

function createVersionedRendererUrl(appUrl, version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new TypeError('Desktop renderer version is required');
  }
  const url = new URL(appUrl);
  url.searchParams.set(DESKTOP_VERSION_PARAM, version);
  return url.href;
}

function createRendererLinkOrigins({ appOrigin, apiOrigin, previewGatewayPort }) {
  const origins = new Set([appOrigin, apiOrigin]);
  if (!Number.isInteger(previewGatewayPort) || previewGatewayPort < 1 || previewGatewayPort > 65535) {
    return origins;
  }
  origins.add(new URL(`http://localhost:${previewGatewayPort}`).origin);
  return origins;
}

async function resolveRendererLinkOrigins({ appOrigin, apiOrigin, loadPreviewGatewayStatus }) {
  const status = await loadPreviewGatewayStatus();
  return createRendererLinkOrigins({
    appOrigin,
    apiOrigin,
    previewGatewayPort: status?.available === true ? status.gatewayPort : Number.NaN,
  });
}

function isAllowedRendererLink(url, allowedHttpOrigins = new Set()) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && allowedHttpOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

function isAllowedRendererDownload(url, apiOrigin) {
  if (typeof url !== 'string' || typeof apiOrigin !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return parsed.origin === new URL(apiOrigin).origin && parsed.pathname.startsWith('/uploads/');
  } catch {
    return false;
  }
}

module.exports = {
  createRendererLinkOrigins,
  createVersionedRendererUrl,
  isAllowedRendererLink,
  isAllowedRendererDownload,
  resolveRendererLinkOrigins,
};
