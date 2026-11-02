import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { resolveFrontendCorsOrigins } from '../../../api/src/config/frontend-origin.ts';
import { sessionAuthPlugin, sessionRoute } from '../../../api/src/infrastructure/session-auth.ts';
import { registerConnectionDiagnostics } from '../../../api/src/routes/connection-diagnostics.ts';

const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify');
const cookie = requireApi('@fastify/cookie');
const cors = requireApi('@fastify/cors');
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test(
  'real browser joins POST timeout, toast, pending handler and disconnected socket',
  { timeout: 30_000 },
  async () => {
    const records = [];
    let admitted, pending, closed, release;
    const admittedSignal = new Promise((resolve) => {
      admitted = resolve;
    });
    const pendingSignal = new Promise((resolve) => {
      pending = resolve;
    });
    const closedSignal = new Promise((resolve) => {
      closed = resolve;
    });
    const responseGate = new Promise((resolve) => {
      release = resolve;
    });
    const app = Fastify({
      logger: {
        level: 'info',
        stream: {
          write(line) {
            const record = JSON.parse(line);
            records.push(record);
            if (record.event === 'connection_diagnostic' && record.source === 'server' && record.route === 'messages') {
              if (record.state === 'pending') pending(record);
              if (record.state === 'aborted') closed(record);
            }
          },
        },
      },
    });
    await app.register(cors, { origin: resolveFrontendCorsOrigins(process.env), credentials: true, maxAge: 600 });
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute);
    registerConnectionDiagnostics(app, 20);
    app.post('/api/messages', async (request, reply) => {
      admitted(request.headers['x-clowder-client-request']);
      await responseGate;
      return reply.code(202).send({ status: 'queued' });
    });
    const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
    let script = '';
    const web = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html');
      response.end(
        request.url === '/fixture.js'
          ? script
          : '<!doctype html><button id="send">Send fixture</button><output id="result"></output><div id="notices"></div><script type="module" src="/fixture.js"></script>',
      );
    });
    let browser;
    try {
      const result = await build({
        root: webRoot,
        configFile: false,
        logLevel: 'silent',
        resolve: { alias: { '@': path.join(webRoot, 'src') } },
        define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(apiOrigin) },
        build: {
          write: false,
          minify: false,
          rollupOptions: {
            input: path.join(webRoot, 'test/browser/fixtures/connection-diagnostics.ts'),
            output: { format: 'es', inlineDynamicImports: true },
          },
        },
      });
      const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
      script = outputs.find((item) => item.type === 'chunk' && item.isEntry)?.code;
      assert.ok(script);
      await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
      const webOrigin = `http://127.0.0.1:${web.address().port}`;
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.clock.install();
      await page.goto(webOrigin);
      await page.waitForSelector('html[data-ready="true"]');
      await page.click('#send');
      const clientRequestId = await admittedSignal;
      const waiting = await pendingSignal;
      assert.equal(waiting.clientRequestId, clientRequestId);
      await page.clock.fastForward(30_100);
      await page.waitForFunction(() => document.querySelector('#result')?.textContent === 'TimeoutError');
      assert.ok((await page.locator('#notices').innerText()).includes('后端连接异常'));
      const disconnected = await closedSignal;
      assert.equal(disconnected.clientRequestId, clientRequestId);
      await page.clock.fastForward(5_100);
      // A browser-native diagnostic fetch carries its cookie, CSRF token and normal CORS preflight.
      await page.waitForFunction(
        () => JSON.parse(localStorage.getItem('cat-cafe:connection-diagnostics:v1') ?? '[]').length === 0,
      );
      const received = records.filter(
        (record) => record.event === 'connection_diagnostic' && record.source === 'browser',
      );
      assert.ok(
        received.some(
          (record) => record.kind === 'http' && record.state === 'failed' && record.clientRequestId === clientRequestId,
        ),
      );
      assert.ok(
        received.some(
          (record) =>
            record.kind === 'connection_notice' &&
            record.state === 'shown' &&
            record.clientRequestId === clientRequestId,
        ),
      );
      assert.ok(!JSON.stringify(received).includes('fixture-private-body'));
      assert.deepEqual(pageErrors, []);
      console.log(
        JSON.stringify({
          apiOrigin,
          webOrigin,
          clientRequestId,
          serverStates: [waiting.state, disconnected.state],
          browserEvents: received.map(({ kind, state }) => ({ kind, state })),
        }),
      );
    } finally {
      release();
      await browser?.close();
      await new Promise((resolve) => web.close(resolve));
      await app.close();
    }
  },
);
