const PREVIEW_GATEWAY_HOST_PATTERN = /^preview-(\d{1,5})\.localhost$/;

function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`${label} must be an integer between 1 and 65535`);
  }
}

/**
 * Carry a preview target in the origin rather than the document query string.
 * Root-relative assets, navigations, fetches, and WebSockets all inherit this
 * hostname, so every request remains independently routable without global
 * "last preview" state.
 */
export function buildPreviewGatewayHostname(targetPort: number): string {
  assertPort(targetPort, 'Preview target port');
  return `preview-${targetPort}.localhost`;
}

export function parsePreviewGatewayHostname(hostname: string): number | null {
  const match = PREVIEW_GATEWAY_HOST_PATTERN.exec(hostname.toLowerCase());
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function buildPreviewGatewayUrl(gatewayPort: number, targetPort: number, targetPath = '/'): string {
  assertPort(gatewayPort, 'Preview gateway port');
  const url = new URL(`http://${buildPreviewGatewayHostname(targetPort)}:${gatewayPort}`);
  const queryIndex = targetPath.indexOf('?');
  if (queryIndex >= 0) {
    url.pathname = targetPath.slice(0, queryIndex) || '/';
    const params = new URLSearchParams(targetPath.slice(queryIndex + 1));
    for (const [key, value] of params) url.searchParams.append(key, value);
  } else {
    url.pathname = targetPath || '/';
  }
  return url.toString();
}
