/** The Host's own static companion surface: a loopback companion origin serving package HTML, nothing else. */
export function companionSurfaceUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !/^companion-[a-f0-9]{32}\.localhost$/.test(url.hostname) ||
    !url.port ||
    !url.pathname.startsWith('/packages/') ||
    !url.pathname.endsWith('.html') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid desktop surface origin');
  return url;
}
/** Another page of the same static surface: same origin, same directory, not the surface itself. */
export function besideSurface(surface: URL, value: string): boolean {
  const body = companionSurfaceUrl(value);
  const directory = (url: URL) => url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  return body.origin === surface.origin && directory(body) === directory(surface) && body.href !== surface.href;
}
