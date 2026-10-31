import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import Fastify from 'fastify';
import {
  createMessageReadDiagnostics,
  type MessageReadDiagnosticEvent,
} from '../src/infrastructure/message-read-diagnostics.js';
import { registerMessageReadDiagnostics } from '../src/infrastructure/message-read-diagnostics-plugin.js';

for (const mode of ['slow-handler', 'hijacked-sse'] as const) {
  test(
    `${mode}: 300 client disconnects release slots and the 301st request remains observed`,
    { timeout: 20_000 },
    async () => {
      const app = Fastify({ forceCloseConnections: true });
      const events: MessageReadDiagnosticEvent[] = [];
      const observer = registerMessageReadDiagnostics(app, {
        onEvent: (event) => events.push(event),
        minBatchMs: 0,
        minRequestMs: Number.POSITIVE_INFINITY,
      });
      let entered = () => {},
        closed = () => {},
        arrivals = 0,
        disconnects = 0;
      let observedRequestId: string | undefined;
      app.get('/disconnect', async (_request, reply) => {
        arrivals++;
        const onClose = closed;
        const ended = new Promise<void>((resolve) => {
          reply.raw.once('close', () => {
            disconnects++;
            onClose();
            resolve();
          });
        });
        if (mode === 'hijacked-sse') {
          reply.hijack();
          reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
          reply.raw.write('data: connected\n\n');
        }
        entered();
        await ended;
        return { ended: true };
      });
      app.get('/observed', async (request) => {
        observedRequestId = request.id;
        await setImmediate();
        const span = observer.beginBatch(1);
        assert.ok(span);
        span.decodeStarted();
        span.end(1, 'ok');
        return { ok: true };
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      assert.ok(address && typeof address !== 'string');
      const agent = new http.Agent({ keepAlive: false });
      try {
        for (let index = 0; index < 300; index++) {
          const arrived = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const serverClosed = new Promise<void>((resolve) => {
            closed = resolve;
          });
          const request = http.get({ host: '127.0.0.1', port: address.port, path: '/disconnect', agent });
          request.on('error', () => {}); // destroying an unfinished request raises ECONNRESET
          const clientClosed = new Promise<void>((resolve) => request.once('close', resolve));
          if (mode === 'slow-handler') {
            await arrived; // prove the diagnostic hook and handler ran before cancellation
            request.destroy();
          } else {
            await new Promise<void>((resolve) => {
              request.once('response', (response) => {
                response.on('error', () => {});
                response.once('data', () => {
                  request.destroy();
                  resolve();
                });
              });
            });
          }
          await Promise.all([clientClosed, serverClosed]);
        }
        assert.equal(arrivals, 300);
        assert.equal(disconnects, 300);
        const status = await new Promise<number | undefined>((resolve, reject) => {
          const request = http.get({ host: '127.0.0.1', port: address.port, path: '/observed', agent }, (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
          });
          request.once('error', reject);
        });
        assert.equal(status, 200);
        await setImmediate();
        observer.stop();
        const batch = events.find((event) => event.kind === 'message_read_batch');
        assert.ok(batch && batch.kind === 'message_read_batch');
        assert.equal(batch.operation, 'GET /observed');
        assert.ok(observedRequestId);
        assert.equal(batch.requestId, observedRequestId);
        const coverage = events.find((event) => event.kind === 'message_read_coverage_end');
        assert.ok(coverage && coverage.kind === 'message_read_coverage_end');
        assert.equal(coverage.observedRequests, 301);
        assert.equal(coverage.unobservedRequests, 0);
        assert.equal(coverage.incompleteRequests, 0);
      } finally {
        agent.destroy();
        await app.close();
      }
    },
  );
}

test('request release is bound to its record outside ALS and is idempotent in another request context', () => {
  const events: MessageReadDiagnosticEvent[] = [];
  const observer = createMessageReadDiagnostics({ onEvent: (event) => events.push(event), minRequestMs: 0 });
  let endFirst = () => {};
  observer.runRequest('first', 'GET /first', (endRequest) => {
    endFirst = endRequest;
  });
  endFirst(); // no ALS context remains on this call stack
  observer.runRequest('second', 'GET /second', (endRequest) => {
    endFirst(); // repeated close must not end the second request or decrement twice
    endRequest();
    endRequest(); // onResponse plus raw close are also safe in either order
  });
  observer.stop();
  assert.deepEqual(
    events.filter((event) => event.kind === 'message_read_request').map((event) => event.requestId),
    ['first', 'second'],
  );
  const coverage = events.find((event) => event.kind === 'message_read_coverage_end');
  assert.ok(coverage && coverage.kind === 'message_read_coverage_end');
  assert.equal(coverage.incompleteRequests, 0);
});
