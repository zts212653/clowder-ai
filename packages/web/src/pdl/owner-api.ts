import { apiFetch } from '@/utils/api-client';

/** Mark a failed owner read; presentation stays at ProjectDataBinding's model boundary. */
export function failRead(error: unknown): never {
  if (error instanceof Error && ['PdlReadError', 'AbortError'].includes(error.name)) throw error;
  const failure = Object.assign(
    new Error(error instanceof Error ? error.message : String(error), { cause: error }),
    error instanceof Error ? error : {},
  );
  failure.name = 'PdlReadError';
  throw failure;
}
/** Application API boundary shared by VM/action bindings; the copied facade is unchanged. */
export async function request<T = Record<string, unknown>>(
  path: string,
  init?: RequestInit,
  options?: Parameters<typeof apiFetch>[2],
): Promise<T> {
  try {
    const response = await apiFetch(path, init, options);
    if (response.status === 204 && response.ok) return undefined as T;
    const body = await response.json();
    const errorEnvelope =
      body &&
      typeof body === 'object' &&
      'error' in body &&
      Object.keys(body).every((key) => ['error', 'details', 'message', 'code', 'statusCode'].includes(key));
    if (!response.ok || errorEnvelope) {
      const detail = body && typeof body === 'object' ? body : {},
        error = detail.error;
      const message = typeof error === 'string' ? error : (error?.message ?? error?.code);
      throw Object.assign(new Error(message ?? `请求失败 (${response.status})`), {
        status: response.status,
        code: detail.code ?? (error && typeof error === 'object' ? error.code : undefined),
      });
    }
    return body as T;
  } catch (error) {
    if ((init?.method ?? 'GET') !== 'GET' || init?.signal?.aborted) throw error;
    failRead(error);
  }
}
export const write = <T = Record<string, unknown>>(path: string, body: unknown, method = 'POST') =>
  request<T>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
