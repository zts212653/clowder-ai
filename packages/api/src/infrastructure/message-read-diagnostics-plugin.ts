import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createMessageReadDiagnostics, type MessageReadDiagnosticOptions } from './message-read-diagnostics.js';

/** API composition only. Route templates exclude query strings and concrete path parameters. */
export function registerMessageReadDiagnostics(app: FastifyInstance, options?: MessageReadDiagnosticOptions) {
  const observer = createMessageReadDiagnostics(
    options ?? {
      onEvent: (event) => app.log.info(event, '[Task229] message read diagnostic'),
    },
  );
  const requestEnds = new WeakMap<FastifyRequest, () => void>();
  app.addHook('onRequest', (request, reply, done) => {
    observer.runRequest(request.id, `${request.method} ${request.routeOptions.url ?? '<unmatched>'}`, (endRequest) => {
      requestEnds.set(request, endRequest);
      reply.raw.once('close', endRequest); // includes client aborts and hijacked streams
      done();
    });
  });
  app.addHook('onResponse', (request, reply, done) => {
    const endRequest = requestEnds.get(request);
    if (endRequest) {
      reply.raw.removeListener('close', endRequest);
      requestEnds.delete(request);
      endRequest();
    }
    done();
  });
  app.addHook('onClose', async () => observer.stop());
  return observer;
}
