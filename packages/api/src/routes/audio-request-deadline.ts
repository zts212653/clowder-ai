import type { FastifyReply, FastifyRequest } from 'fastify';

export const AUDIO_REQUEST_TIMEOUT_MS = 8_000;
export const AUDIO_MUTATION_TIMEOUT_MS = 120_000;

/** Bound fetch and body decoding; client cancellation also stops the upstream request. */
export async function requestAudioJson(
  request: FastifyRequest,
  url: string,
  method: string,
  body: unknown,
  timeoutMs = AUDIO_REQUEST_TIMEOUT_MS,
  cancelWithCaller = true,
) {
  const controller = new AbortController();
  const duration = Number.isFinite(timeoutMs)
    ? Math.min(method === 'POST' ? AUDIO_MUTATION_TIMEOUT_MS : AUDIO_REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs))
    : AUDIO_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(
    () => controller.abort(new DOMException('Audio service request deadline exceeded', 'TimeoutError')),
    duration,
  );
  const cancel = () => controller.abort(new DOMException('Audio service request cancelled', 'AbortError'));
  const onError = (error: Error) => {
    if (cancelWithCaller && error.name === 'AbortError') cancel();
  };
  if (cancelWithCaller) {
    request.raw.once('aborted', cancel);
    if (request.raw.aborted) cancel();
  }
  request.raw.on('error', onError);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, ok: response.ok, data: (await response.json()) as unknown };
  } finally {
    clearTimeout(timer);
    request.raw.off('aborted', cancel);
    request.raw.off('error', onError);
  }
}

export function audioRequestFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return reply.code(504).send({
      error:
        error.name === 'TimeoutError' ? 'Audio service request deadline exceeded' : 'Audio service request cancelled',
    });
  return reply.code(502).send({ error: 'Audio service unavailable' });
}
