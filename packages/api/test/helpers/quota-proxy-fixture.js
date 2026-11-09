import { execFileSync } from 'node:child_process';
import dns from 'node:dns';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import tls from 'node:tls';

export async function quotaProxyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'quota-proxy-tls-'));
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
      '/CN=chatgpt.com',
      '-addext',
      'subjectAltName=DNS:chatgpt.com,DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const cert = readFileSync(join(root, 'cert.pem'));
  const sockets = new Set();
  const requests = [];
  const connects = [];
  const state = {
    status: 200,
    stall: false,
    trustCertificate: true,
    body: JSON.stringify({ rate_limit: { primary_window: { used_percent: 23 } } }),
  };
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  };
  const origin = https.createServer({ key: readFileSync(join(root, 'key.pem')), cert }, (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (state.stall) return;
    res.writeHead(state.status, {
      'content-type': 'application/json',
      location: 'https://do-not-forward.invalid/token',
    });
    res.end(state.body);
  });
  origin.on('connection', track);
  origin.on('tlsClientError', () => {});
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer();
  proxy.on('connection', track);
  proxy.on('connect', (req, client, head) => {
    connects.push(req.url);
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    track(upstream);
    client.on('close', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const originalTls = tls.connect;
  mock.method(tls, 'connect', (options, callback) =>
    originalTls({ ...options, ...(state.trustCertificate ? { ca: cert } : {}) }, callback),
  );
  const originalLookup = dns.lookup;
  mock.method(dns, 'lookup', (hostname, ...args) => {
    if (hostname === 'chatgpt.com') {
      const callback = args.at(-1);
      const error = Object.assign(new Error('fixture blocks direct official network'), { code: 'ENETUNREACH' });
      queueMicrotask(() => callback(error));
      return;
    }
    return originalLookup.call(dns, hostname, ...args);
  });
  return {
    root,
    requests,
    connects,
    state,
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    directUrl: `https://127.0.0.1:${origin.address().port}/usage`,
    async close() {
      mock.restoreAll();
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise((r) => origin.close(r)), new Promise((r) => proxy.close(r))]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
