import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import tls from 'node:tls';

export async function dotProxyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dot-proxy-tls-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
      '-subj',
      '/CN=callback.example.com',
      '-addext',
      'subjectAltName=DNS:callback.example.com,DNS:dns.google',
    ],
    { stdio: 'ignore' },
  );
  const key = await readFile(join(root, 'key.pem'));
  const cert = await readFile(join(root, 'cert.pem'));
  const sockets = new Set<Socket>();
  const clientSockets = new Set<Socket>();
  const connects: string[] = [];
  const callbacks: { host: string; sni: string; path: string; body: string; headers: http.IncomingHttpHeaders }[] = [];
  const queries: string[] = [];
  const settings = {
    a: ['93.184.216.34'],
    aaaa: [] as string[],
    dnsDelayMs: 0,
    aaaaDelayMs: 0,
    callbackDelayMs: 0,
    connectStatus: 200,
    stallConnect: false,
    stallCallbackConnect: false,
    stallTls: false,
    trustCertificate: true,
    status: 200,
    streamForever: false,
    dnsBody: undefined as unknown,
    dnsByType: {} as Partial<Record<1 | 28, unknown>>,
    dnsText: undefined as string | undefined,
    callbackText: undefined as string | undefined,
  };
  async function serveDns(req: http.IncomingMessage, res: http.ServerResponse) {
    queries.push(req.url ?? '');
    const u = new URL(req.url ?? '/', 'https://dns.google');
    const type = Number(u.searchParams.get('type'));
    const delay = type === 28 ? settings.aaaaDelayMs || settings.dnsDelayMs : settings.dnsDelayMs;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    res.setHeader('content-type', 'application/json');
    const body = settings.dnsByType[type as 1 | 28] ??
      settings.dnsBody ?? {
        Status: 0,
        TC: false,
        Question: [{ name: 'callback.example.com.', type }],
        Answer: (type === 1 ? settings.a : settings.aaaa).map((data) => ({
          name: 'callback.example.com.',
          type,
          data,
        })),
      };
    res.end(settings.dnsText ?? JSON.stringify(body));
  }
  async function serveCallback(req: http.IncomingMessage, res: http.ServerResponse, sni: string) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    callbacks.push({ host: req.headers.host ?? '', sni, path: req.url ?? '', body, headers: req.headers });
    if (settings.callbackDelayMs) await new Promise((r) => setTimeout(r, settings.callbackDelayMs));
    res.writeHead(settings.status);
    if (settings.streamForever) {
      res.write('partial');
      return;
    }
    res.end(settings.callbackText ?? JSON.stringify({ challenge: JSON.parse(body).challenge }));
  }
  const origin = https.createServer({ key, cert }, async (req, res) => {
    const sni = (req.socket as tls.TLSSocket & { servername?: string }).servername || '';
    if (sni === 'dns.google') await serveDns(req, res);
    else await serveCallback(req, res, sni);
  });
  origin.on('tlsClientError', () => {});
  origin.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  const port = (origin.address() as net.AddressInfo).port;
  const proxy = http.createServer();
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('connect', (req, client) => {
    connects.push(req.url ?? '');
    if (settings.stallConnect || (settings.stallCallbackConnect && req.url !== 'dns.google:443')) return;
    if (settings.connectStatus !== 200) {
      client.end(`HTTP/1.1 ${settings.connectStatus} Denied\r\n\r\n`);
      return;
    }
    const upstream = net.connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (settings.stallTls) return;
      client.pipe(upstream);
      upstream.pipe(client);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => sockets.delete(upstream));
    client.on('close', () => upstream.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const original = tls.connect;
  mock.method(tls, 'connect', (options: tls.ConnectionOptions, callback?: () => void) => {
    const socket = original({ ...options, ...(settings.trustCertificate ? { ca: cert } : {}) }, callback);
    clientSockets.add(socket);
    socket.on('close', () => clientSockets.delete(socket));
    return socket;
  });
  const originalRequest = http.request;
  mock.method(http, 'request', (options: http.RequestOptions, callback?: (res: http.IncomingMessage) => void) => {
    const request = originalRequest(options, callback);
    request.on('socket', (socket) => {
      clientSockets.add(socket);
      socket.on('close', () => clientSockets.delete(socket));
    });
    return request;
  });
  return {
    proxyUrl: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`,
    connects,
    callbacks,
    queries,
    settings,
    sockets,
    clientSockets,
    async close() {
      mock.restoreAll();
      for (const s of sockets) s.destroy();
      await Promise.all([
        new Promise<void>((r) => proxy.close(() => r())),
        new Promise<void>((r) => origin.close(() => r())),
      ]);
      await rm(root, { recursive: true, force: true });
    },
  };
}
