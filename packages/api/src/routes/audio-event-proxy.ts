/** F195 audio event forwarding, using the controller route's identity and service resolution. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type AudioEventProxyOptions = {
  requireIdentity: (request: FastifyRequest, reply: FastifyReply) => boolean;
  resolveServiceUrl: () => string;
};

export function registerAudioEventProxy(app: FastifyInstance, options: AudioEventProxyOptions): void {
  app.get('/api/audio/events', async (req, reply) => {
    if (!options.requireIdentity(req, reply)) return;
    const upstreamAbort = new AbortController();
    let clientClosed = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const closeUpstream = () => {
      if (clientClosed) return;
      clientClosed = true;
      upstreamAbort.abort();
      void reader?.cancel().catch(() => undefined);
    };
    const closeOnRequestAbort = () => {
      if (req.raw.aborted) closeUpstream();
    };
    const closeOnResponseClose = () => {
      if (!reply.raw.writableEnded) closeUpstream();
    };
    req.raw.once('close', closeOnRequestAbort);
    reply.raw.once('close', closeOnResponseClose);
    try {
      const resp = await fetch(`${options.resolveServiceUrl()}/events`, { signal: upstreamAbort.signal });
      if (clientClosed) return;
      if (!resp.ok || !resp.body) {
        return reply.status(502).send({ error: 'Audio service SSE unavailable' });
      }
      const origin = req.headers.origin;
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(origin && {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
        }),
      });
      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (reply.raw.destroyed || reply.raw.writableEnded) break;
          reply.raw.write(decoder.decode(value, { stream: true }));
        }
      } catch {
        // stream ended or client disconnected
      } finally {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      }
    } catch {
      if (clientClosed) return;
      return reply.status(502).send({ error: 'Audio service unavailable' });
    } finally {
      req.raw.off('close', closeOnRequestAbort);
      reply.raw.off('close', closeOnResponseClose);
    }
  });
}
