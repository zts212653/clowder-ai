const ACTIVITY_TRACKING_EXEMPT_API_PATHS = new Set(['/api/health', '/api/ready']);

export function shouldTrackApiActivity(requestUrl: string): boolean {
  const [path] = requestUrl.split('?', 1);
  if (!path?.startsWith('/api/')) return false;
  if (path.startsWith('/api/brake/')) return false;
  if (ACTIVITY_TRACKING_EXEMPT_API_PATHS.has(path)) return false;
  return true;
}
