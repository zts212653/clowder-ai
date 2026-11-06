/** DSH stores an opaque ACP [provider, model] route; only its display label is decoded. */
export function dshModelLabel(value: string) {
  if (!value.startsWith('[')) return value;
  try {
    const route: unknown = JSON.parse(value);
    return Array.isArray(route) && route.length === 2 && route.every((part) => typeof part === 'string' && part)
      ? route.join(' / ')
      : value;
  } catch {
    return value;
  }
}
