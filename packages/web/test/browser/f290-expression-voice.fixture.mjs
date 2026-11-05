import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';

const exec = promisify(execFile);
const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const webRequire = createRequire(join(webRoot, 'package.json'));

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
const close = (server) =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });

/** Uses the real product iframe, hooks and source attributes; Host plugin/session responses are fixture data. */
export async function expressionHostFixture({
  appearanceControls = false,
  worldRail = false,
  port = 0,
  ownerControl,
} = {}) {
  let serviceUrl = '',
    serviceInstanceId,
    connections = [],
    script = '',
    stylesheet = '';
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://fixture.invalid').pathname;
    if (path === '/bundle.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(script);
      return;
    }
    if (path === '/bundle.css') {
      response.writeHead(200, { 'content-type': 'text/css' }).end(stylesheet);
      return;
    }
    if (path === '/api/session') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ csrfToken: 'explicit-host-fixture' }));
      return;
    }
    if (ownerControl && path.startsWith('/api/plugins/official.collective-connector/')) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      response.once('close', abort);
      try {
        const chunks = [];
        for await (const bytes of request) chunks.push(bytes);
        const body = Buffer.concat(chunks).toString();
        const result = await ownerControl(
          {
            method: request.method,
            path: path.slice('/api/plugins/official.collective-connector/'.length),
            query: Object.fromEntries(new URL(request.url, 'http://fixture.invalid').searchParams),
            headers: request.headers,
            ...(body ? { body: JSON.parse(body) } : {}),
          },
          controller.signal,
        );
        response.writeHead(result.status, result.headers).end(JSON.stringify(result.body));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }));
      } finally {
        response.off('close', abort);
        controller.abort();
      }
      return;
    }
    if (path === '/api/plugins/official.collective-connector/connections') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          runtimeStatus: 'active',
          connections,
          localService: { state: 'ready', serviceUrl, ...(serviceInstanceId ? { serviceInstanceId } : {}) },
        }),
      );
      return;
    }
    if (path.startsWith('/api/')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<!doctype html><html><head><link rel="stylesheet" href="/bundle.css"><style>
      html,body,#root{margin:0;width:100%;height:100%;font-family:system-ui}.h-full{height:100%}.w-full{width:100%}iframe{border:0}
      #root{display:grid;grid-template-rows:${appearanceControls ? 'auto ' : ''}minmax(0,1fr)}.f290-host-room{width:100%;height:100%;min-width:0;min-height:0}.f290-host-shell{display:grid;grid-template-columns:52px minmax(0,1fr);min-height:0}.fixture-world-rail{display:flex;flex-direction:column;gap:4px;border-right:1px solid #ddd}.fixture-controls{display:flex;gap:12px;padding:4px}
      </style></head><body><div id="root"></div><script id="fixture-config" type="application/json">${JSON.stringify({ serviceUrl, appearanceControls, worldRail })}</script>
      <script type="module" src="/bundle.js"></script></body></html>`);
  });
  const url = await listen(server, port);
  try {
    const result = await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic', jsxDev: false },
      define: {
        'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(url),
        'process.env.NEXT_PUBLIC_COLLECTIVE_SERVICE_URL': '""',
        'process.env.NODE_ENV': '"production"',
        'process.env': '{}',
      },
      resolve: { alias: [{ find: '@', replacement: join(webRoot, 'src') }] },
      css: {
        postcss: {
          plugins: [
            webRequire('tailwindcss')({
              ...webRequire(join(webRoot, 'tailwind.config.js')),
              content: [join(webRoot, 'src/**/*.{ts,tsx}')],
            }),
          ],
        },
      },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: join(webRoot, 'test/browser/fixtures/f290-expression-host.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const output = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    script = output.find((item) => item.type === 'chunk' && item.isEntry).code;
    stylesheet = output
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => String(item.source))
      .join('\n');
    return {
      url,
      setService(value, options = {}) {
        serviceUrl = value;
        serviceInstanceId = options.serviceInstanceId;
        connections = options.connections ?? [];
      },
      close: () => close(server),
    };
  } catch (error) {
    await close(server);
    throw error;
  }
}

/** Declared ASR fixture: decodes actual browser-recorded audio, then returns controlled words or failure.
 * It proves capture/transport/lifecycle, never recognition accuracy or physical-device quality. */
export async function expressionVoiceServiceFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'f290-private-voice-'));
  const requests = [],
    waiters = [];
  let recordings = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/audio/transcriptions') {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': request.headers['content-type'] },
      }).formData();
      const file = form.get('file');
      assert.ok(file instanceof File && file.size > 0, 'The real MediaRecorder must supply audio bytes');
      const path = join(directory, `recording-${++recordings}.audio`);
      await writeFile(path, Buffer.from(await file.arrayBuffer()));
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path]);
      const media = JSON.parse(stdout);
      assert.ok(media.streams.some((stream) => stream.codec_type === 'audio'));
      const delivery = {
        bytes: file.size,
        type: file.type,
        language: form.get('language'),
        complete(text) {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text }));
        },
        fail() {
          response.writeHead(503).end('Explicit transcription fixture failure');
        },
      };
      const waiting = waiters.shift();
      if (waiting) waiting(delivery);
      else requests.push(delivery);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  const url = await listen(server);
  return {
    url,
    next: () => (requests.length ? Promise.resolve(requests.shift()) : new Promise((resolve) => waiters.push(resolve))),
    async close() {
      await close(server);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
