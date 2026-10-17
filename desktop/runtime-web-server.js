const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { loadDesktopWebConfig } = require('./runtime-web-config');
const { createStartupTimeline } = require('./startup-timing');

function resolveDesktopWebHost(hostname = '127.0.0.1') {
  if (!['127.0.0.1', '0.0.0.0'].includes(hostname)) throw new Error('Unsupported desktop Web listen address');
  return hostname;
}

function createDesktopNextApp(next, options) {
  // Next 14 automatically attaches an upgrade listener to options.httpServer or
  // req.socket.server. Keep that listener on its own unbound transport so the
  // real gateway remains the only owner of production socket upgrades.
  return next({ ...options, dev: false, httpServer: http.createServer() });
}

// A packaged Next build can contain build-time rewrite destinations. The isolated
// desktop gateway owns these routes at runtime instead of reaching another instance.
function createDesktopWebGateway(handler, apiPort, timeline) {
  const proxy = (url) => /^\/(?:api|socket\.io|uploads)(?:\/|\?|$)/.test(url || '');
  let observedFirstRequest = false;
  const server = http.createServer((request, response) => {
    if (!proxy(request.url)) {
      if (!observedFirstRequest && (request.url === '/' || request.url?.startsWith('/?'))) {
        observedFirstRequest = true;
        const began = performance.now();
        let finished = false;
        timeline?.mark('firstRequest');
        const reportResponse = (phase) =>
          timeline?.mark(phase, {
            durationMs: Math.round(performance.now() - began),
            statusCode: response.statusCode,
          });
        response.once('finish', () => {
          finished = true;
          reportResponse('firstResponse');
        });
        response.once('close', () => {
          if (!finished) reportResponse('firstResponseAborted');
        });
      }
      return handler(request, response);
    }
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: apiPort,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: `localhost:${apiPort}` },
      },
      (result) => {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end('Isolated API unavailable');
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    if (!proxy(request.url)) return socket.destroy();
    const upstream = net.connect(apiPort, '127.0.0.1', () => {
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
      for (const [name, value] of Object.entries(request.headers))
        upstream.write(`${name}: ${name === 'host' ? `localhost:${apiPort}` : value}\r\n`);
      upstream.write('\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  return server;
}
async function start() {
  const [web, frontendPort, apiPort, hostname] = process.argv.slice(2);
  const host = resolveDesktopWebHost(hostname);
  process.env.NODE_ENV = 'production';
  const timeline = createStartupTimeline({ component: 'web' });
  const requireWeb = createRequire(path.join(web, 'package.json'));
  await timeline.runPhase('configuration', () => loadDesktopWebConfig(web, requireWeb));
  const next = await timeline.runPhase('require-next', () => requireWeb('next'));
  const app = createDesktopNextApp(next, { dir: web, hostname: host, port: Number(frontendPort) });
  await timeline.runPhase('prepare', () => app.prepare());
  const server = createDesktopWebGateway(app.getRequestHandler(), Number(apiPort), timeline);
  await timeline.runPhase(
    'listen',
    () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(frontendPort), host, () => {
          server.off('error', reject);
          resolve();
        });
      }),
  );
  timeline.mark('listening');
  const stop = () => server.close(() => app.close().then(() => process.exit(0)));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
if (require.main === module)
  start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { createDesktopWebGateway, createDesktopNextApp, resolveDesktopWebHost };
