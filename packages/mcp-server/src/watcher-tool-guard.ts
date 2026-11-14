import { invocationFetch, resolveInvocationCredentials, resolveScopedApiBaseUrl } from './tools/invocation-auth.js';

/** Admission precedes local readers as well as HTTP writers; failed calls consume the same durable six-call budget. */
export async function admitWatcherTool(toolName: string, callId: string): Promise<void> {
  const credentials = resolveInvocationCredentials();
  if (!credentials.invocationId || !credentials.callbackToken)
    throw new Error('Watcher invocation credentials unavailable');
  const base = resolveScopedApiBaseUrl() ?? process.env.CAT_CAFE_API_URL;
  if (!base) throw new Error('Watcher API unavailable');
  const response = await invocationFetch(`${base}/api/callbacks/watcher-tool-admission`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-invocation-id': credentials.invocationId,
      'x-callback-token': credentials.callbackToken,
    },
    body: JSON.stringify({ toolName, callId }),
  });
  if (!response.ok) throw new Error(`Watcher tool admission refused (${response.status}): ${await response.text()}`);
}

/** The raw result remains in the native transcript; this is the bounded model-facing response. */
export function boundWatcherToolResponse<
  T extends { content: Array<{ type: string; text?: string; [key: string]: unknown }>; [key: string]: unknown },
>(result: T, callId: string): T {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, 'utf8') <= 1200) return result;
  let excerpt = serialized.slice(0, 750);
  while (Buffer.byteLength(excerpt, 'utf8') > 750) excerpt = excerpt.slice(0, -1);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          bounded: true,
          callId,
          excerpt,
          continuation: '本次回包有界；需要更多原文时缩小读取范围。写入可能已成功，请按原幂等标识核对，不重复写入。',
        }),
      },
    ],
  } as T;
}
