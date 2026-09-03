export function resolveCollectivePublicUrl(value: string | undefined, host: string, port: number): string {
  const configured = value?.trim();
  const resolved = configured ? new URL(configured) : new URL(`http://${host}:${port}`);
  if (!['http:', 'https:'].includes(resolved.protocol) || resolved.username || resolved.password) {
    throw new Error('COLLECTIVE_SERVICE_PUBLIC_URL must be an HTTP(S) URL without embedded credentials');
  }
  if (resolved.protocol === 'http:' && !isLoopbackHostname(resolved.hostname)) {
    throw new Error('COLLECTIVE_SERVICE_PUBLIC_URL must use HTTPS unless it targets loopback');
  }
  resolved.pathname = '/';
  resolved.search = '';
  resolved.hash = '';
  return resolved.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
