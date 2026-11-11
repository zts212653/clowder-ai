import { apiFetch } from '@/utils/api-client';

/** HTTP transport for an opaque iframe, restricted to its installed plugin and activation. */
export async function requestPluginHttp(
  entry: { pluginId: string; instanceId: string; generation: string },
  input: unknown,
  signal?: AbortSignal,
  options?: { notifyFailure?: boolean },
) {
  if (
    !input ||
    typeof input !== 'object' ||
    !('path' in input) ||
    typeof input.path !== 'string' ||
    !('method' in input) ||
    typeof input.method !== 'string' ||
    !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)
  )
    throw new Error('插件 HTTP 请求无效');
  const prefix = `/api/plugins/${encodeURIComponent(entry.pluginId)}/`;
  const target = new URL(`${prefix}${input.path.replace(/^\//, '')}`, 'https://plugin.invalid');
  if (!target.pathname.startsWith(prefix) || target.hash) throw new Error('插件 HTTP 路径超出范围');
  const response = await apiFetch(
    `${target.pathname}${target.search}`,
    {
      method: input.method,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-clowder-plugin-ui-instance': entry.instanceId,
        'x-clowder-plugin-ui-generation': entry.generation,
      },
      ...(input.method !== 'GET' && input.method !== 'HEAD' && 'body' in input
        ? { body: JSON.stringify(input.body) }
        : {}),
      signal,
    },
    options,
  );
  const text = await response.text();
  if (text.length > 24_000_000) throw new Error('插件 HTTP 响应超过大小限制');
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text,
  };
}
