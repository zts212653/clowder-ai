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

export interface PreviewTargetPath {
  pathname: string;
  search: string;
  hash: string;
}

export function parsePreviewTargetPath(targetPath = '/'): PreviewTargetPath {
  const hashIndex = targetPath.indexOf('#');
  const pathAndSearch = hashIndex >= 0 ? targetPath.slice(0, hashIndex) : targetPath;
  const searchIndex = pathAndSearch.indexOf('?');
  return {
    pathname: (searchIndex >= 0 ? pathAndSearch.slice(0, searchIndex) : pathAndSearch) || '/',
    search: searchIndex >= 0 ? pathAndSearch.slice(searchIndex) : '',
    hash: hashIndex >= 0 ? targetPath.slice(hashIndex) : '',
  };
}

function applyPreviewTargetPath(url: URL, targetPath: string): void {
  const parsed = parsePreviewTargetPath(targetPath);
  url.pathname = parsed.pathname;
  url.search = parsed.search;
  url.hash = parsed.hash;
}

export function canonicalizePreviewTargetPath(targetPath = '/'): string {
  const url = new URL('http://preview-target.localhost');
  applyPreviewTargetPath(url, targetPath);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildPreviewGatewayUrl(gatewayPort: number, targetPort: number, targetPath = '/'): string {
  assertPort(gatewayPort, 'Preview gateway port');
  const url = new URL(`http://${buildPreviewGatewayHostname(targetPort)}:${gatewayPort}`);
  applyPreviewTargetPath(url, targetPath);
  return url.toString();
}
