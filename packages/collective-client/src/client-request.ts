/** Explicitly identifies read-only POST projections; it never changes the wire request. */
export interface ClientReadPolicy {
  readonly readOnly: true;
}
export type ClientRequest = <Result>(path: string, init?: RequestInit, policy?: ClientReadPolicy) => Promise<Result>;

/** Called only after admission to the serial lane. The deadline includes JSON body consumption. */
export async function fetchClientJson<Result>(path: string, init: RequestInit, policy?: ClientReadPolicy) {
  const readOnly = (init.method ?? 'GET').toUpperCase() === 'GET' || policy?.readOnly === true;
  const abort = readOnly ? new AbortController() : undefined;
  const cancel = () => abort?.abort(init.signal?.reason);
  const timer = abort
    ? setTimeout(() => abort.abort(new DOMException('读取超时，请重试。', 'TimeoutError')), 30_000)
    : undefined;
  if (abort) {
    init.signal?.addEventListener('abort', cancel, { once: true });
    if (init.signal?.aborted) cancel();
  }
  try {
    const response = await fetch(path, abort ? { ...init, signal: abort.signal } : init);
    const payload = (await response.json()) as Result & { error?: { code?: string; message?: string } };
    return { response, payload };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) init.signal?.removeEventListener('abort', cancel);
  }
}

export function collectiveClientErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CollectiveClientRequestError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly code?: string,
  ) {
    super(detail);
  }
}
