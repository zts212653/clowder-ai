import type { FastifyReply, FastifyRequest } from 'fastify';

/** A disconnected reader stops queued workers and any active index/payload work. */
export async function withTranscriptReadSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Transcript reader disconnected'));
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
