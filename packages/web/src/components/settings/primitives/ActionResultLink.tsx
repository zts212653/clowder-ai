interface LinkResult {
  readonly render?: string;
  readonly data?: unknown;
  readonly label?: string;
}

/** Links remain explicit owner actions. Relative app paths and exact loopback
 * viewers join the existing HTTPS destinations; credentials and other schemes do not. */
export function actionResultHref(result: LinkResult | undefined): string | null {
  if (
    !result ||
    !['url', 'polling'].includes(result.render ?? '') ||
    !result.data ||
    typeof result.data !== 'object' ||
    !('url' in result.data) ||
    typeof result.data.url !== 'string'
  )
    return null;
  const raw = result.data.url;
  try {
    if (raw.startsWith('/')) {
      if (raw.startsWith('//')) return null;
      const url = new URL(raw, 'https://operation.invalid');
      return url.origin === 'https://operation.invalid' &&
        !url.username &&
        !url.password &&
        !url.pathname.startsWith('//')
        ? `${url.pathname}${url.search}${url.hash}`
        : null;
    }
    const url = new URL(raw);
    if (url.username || url.password) return null;
    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function ActionResultLink({
  result,
  testId,
  fallbackLabel = '打开页面',
}: {
  readonly result: LinkResult | undefined;
  readonly testId: string;
  readonly fallbackLabel?: string;
}) {
  const href = actionResultHref(result);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      className="inline-flex rounded-lg border border-cafe-border px-4 py-2 text-sm font-medium text-cafe-secondary hover:bg-cafe-surface-sunken"
      data-testid={testId}
    >
      {result?.label ?? fallbackLabel}
    </a>
  ) : null;
}
