import http from 'node:http';
import { createGunzip, createInflate } from 'node:zlib';
import httpProxy from 'http-proxy';
import { BRIDGE_SCRIPT } from './bridge-script.js';
import { validatePort } from './port-validator.js';
import { buildWsPatchScript } from './ws-patch-script.js';

export interface PreviewGatewayOptions {
  /** 0 = random port */
  port: number;
  host?: string;
  /** Runtime-configured ports to exclude */
  runtimePorts?: number[];
}

/**
 * Preview Gateway — 独立端口的反向代理。
 * iframe 永远只打开 gateway URL，不直接连 localhost:xxxx。
 *
 * 请求：GET http://gateway:PORT/path?__preview_port=3847
 *   → proxy to http://localhost:3847/path
 *
 * 安全：loopback-only + 端口白名单 + 剥离 X-Frame-Options/CSP frame-ancestors
 * WebSocket upgrade 代理（HMR）
 */
export class PreviewGateway {
  private server: http.Server;
  private proxy: httpProxy;
  private port: number;
  private host: string;
  private runtimePorts: number[];
  actualPort = 0;

  constructor(opts: PreviewGatewayOptions) {
    this.port = opts.port;
    this.host = opts.host ?? '127.0.0.1';
    this.runtimePorts = opts.runtimePorts ?? [];

    this.proxy = httpProxy.createProxyServer({
      ws: true,
      xfwd: false,
      changeOrigin: true,
      selfHandleResponse: true,
    });

    // Prevent unhandled proxy errors from crashing the process
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.proxy.on('error', (err: Error, _req: any, res: any) => {
      // res may be a ServerResponse (HTTP) or a Socket (WS upgrade)
      if (res && 'writeHead' in res && !res.headersSent) {
        (res as http.ServerResponse).writeHead(502, { 'Content-Type': 'application/json' });
        (res as http.ServerResponse).end(JSON.stringify({ error: 'Proxy error', message: err.message }));
      } else if (res && 'destroy' in res) {
        (res as import('node:net').Socket).destroy();
      }
    });

    // Handle proxied responses: strip iframe headers + inject bridge + WS patch scripts into HTML
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.proxy.on('proxyRes', (proxyRes: any, _req: any, res: any) => {
      const clientRes = res as http.ServerResponse;
      // Strip iframe-blocking headers
      delete proxyRes.headers['x-frame-options'];
      const csp = proxyRes.headers['content-security-policy'];
      if (typeof csp === 'string') {
        const cleaned = csp
          .split(';')
          .filter((d: string) => !d.trim().startsWith('frame-ancestors'))
          .join(';')
          .trim();
        if (cleaned) {
          proxyRes.headers['content-security-policy'] = cleaned;
        } else {
          delete proxyRes.headers['content-security-policy'];
        }
      }

      const ct = (proxyRes.headers['content-type'] ?? '') as string;
      const isHtml = ct.includes('text/html');

      if (!isHtml) {
        // Non-HTML: pipe through unchanged
        clientRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(clientRes);
        return;
      }

      // HTML: buffer body, inject bridge script, then send
      const encoding = (proxyRes.headers['content-encoding'] ?? '') as string;
      // If encoding is unsupported (e.g. br), passthrough without injection
      // 'identity' means no encoding, treat same as empty
      if (encoding && encoding !== 'gzip' && encoding !== 'deflate' && encoding !== 'identity') {
        clientRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(clientRes);
        return;
      }
      const chunks: Buffer[] = [];
      // Decompress if needed
      let stream: NodeJS.ReadableStream = proxyRes;
      if (encoding === 'gzip') {
        stream = proxyRes.pipe(createGunzip());
      } else if (encoding === 'deflate') {
        stream = proxyRes.pipe(createInflate());
      }

      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf-8');
        // Build injection payload: bridge script + WS port patch for HMR
        const targetPort = (_req as Record<string, unknown>).__catCafeTargetPort as number | undefined;
        const wsPatch = targetPort ? buildWsPatchScript(targetPort) : '';
        const injection = wsPatch + BRIDGE_SCRIPT;
        // Inject before </head> or before </body> or at end
        if (html.includes('</head>')) {
          html = html.replace('</head>', `${injection}</head>`);
        } else if (html.includes('<body')) {
          html = html.replace(/<body([^>]*)>/, `<body$1>${injection}`);
        } else {
          html = injection + html;
        }
        // Remove content-encoding (we've decompressed) and update content-length
        const headers = { ...proxyRes.headers };
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        const buf = Buffer.from(html, 'utf-8');
        headers['content-length'] = String(buf.length);
        clientRes.writeHead(proxyRes.statusCode ?? 200, headers);
        clientRes.end(buf);
      });
      stream.on('error', () => {
        // Fallback: send without injection
        clientRes.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        clientRes.end(Buffer.concat(chunks));
      });
    });

    this.server = http.createServer((req, res) => {
      const parsed = this.parseTarget(req);
      if (!parsed) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing __preview_port query parameter' }));
        return;
      }

      const validation = validatePort(parsed.port, {
        host: parsed.host,
        gatewaySelfPort: this.actualPort,
        runtimePorts: this.runtimePorts,
      });
      if (!validation.allowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: validation.reason }));
        return;
      }

      // Store target port for proxyRes handler (before stripping params)
      (req as unknown as Record<string, unknown>).__catCafeTargetPort = parsed.port;

      // Strip preview params from forwarded URL
      const url = new URL(req.url!, `http://${req.headers.host}`);
      url.searchParams.delete('__preview_port');
      url.searchParams.delete('__preview_host');
      req.url = url.pathname + (url.search === '?' ? '' : url.search);

      const target = `http://${parsed.host}:${parsed.port}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.proxy.web(req, res, { target }, (err: any) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
        }
      });
    });

    // WebSocket upgrade handler (HMR)
    this.server.on('upgrade', (req, socket, head) => {
      const parsed = this.parseTarget(req);
      if (!parsed) {
        socket.destroy();
        return;
      }
      const validation = validatePort(parsed.port, {
        host: parsed.host,
        gatewaySelfPort: this.actualPort,
        runtimePorts: this.runtimePorts,
      });
      if (!validation.allowed) {
        socket.destroy();
        return;
      }
      const target = `http://${parsed.host}:${parsed.port}`;
      socket.on('error', () => socket.destroy()); // prevent unhandled socket error crash
      this.proxy.ws(req, socket, head, { target });
    });
  }

  private parseTarget(req: http.IncomingMessage): { port: number; host: string } | null {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const portStr = url.searchParams.get('__preview_port');
    if (!portStr) return null;
    const port = Number.parseInt(portStr, 10);
    if (Number.isNaN(port)) return null;
    const host = url.searchParams.get('__preview_host') ?? 'localhost';
    return { port, host };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.server.off('error', handleError);
        this.server.off('listening', handleListening);
      };

      const handleError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const handleListening = () => {
        cleanup();
        const addr = this.server.address() as { port: number } | null;
        this.actualPort = addr?.port ?? 0;
        resolve();
      };

      this.server.once('error', handleError);
      this.server.once('listening', handleListening);
      this.server.listen(this.port, this.host);
    });
  }

  async stop(): Promise<void> {
    this.proxy.close();

    if (!this.server.listening) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}
