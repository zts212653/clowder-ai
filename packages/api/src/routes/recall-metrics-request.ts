import type { FastifyReply, FastifyRequest } from 'fastify';

/** A disconnected metrics request owns cancellation of its queued/active job. */
export async function withRecallMetricsSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Recall metrics reader disconnected'));
  const close = () => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once('aborted', abort);
  reply.raw.once('close', close);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  try {
    return await read(controller.signal);
  } finally {
    request.raw.removeListener('aborted', abort);
    reply.raw.removeListener('close', close);
  }
}
