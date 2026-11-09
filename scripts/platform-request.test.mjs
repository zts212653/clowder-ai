import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('the real CLI sends the complete multipart over HTTPS and returns a persistent raw response without exposing its key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-cli-tls-'));
  const cert = join(root, 'cert.pem');
  const key = join(root, 'tls-key.pem');
  const fakeKey = ['sk', 'proj', 'F317_CLI_FIXTURE_'.repeat(4)].join('-');
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
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
  const observed = [];
  const image = Buffer.alloc(1_450_000, 0x82);
  const providerBody = JSON.stringify({
    data: [{ b64_json: 'R'.repeat(3_000_000) }],
    usage: { input_tokens: 1455, output_tokens: 3568 },
  });
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = await new Request('https://fixture.invalid', {
      method: 'POST',
      headers: req.headers,
      body: Buffer.concat(chunks),
    }).formData();
    observed.push({
      path: req.url,
      authenticated: req.headers.authorization === `Bearer ${fakeKey}`,
      model: form.get('model'),
      tags: form.getAll('tag'),
      prompt: form.get('prompt'),
      image: Buffer.from(await form.get('image').arrayBuffer()),
    });
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'fixture-real-https' });
    res.end(providerBody);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let proxyCalls = 0;
  let proxySawAuthentication = false;
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connect', (request, socket, head) => {
    proxyCalls++;
    proxySawAuthentication ||= Boolean(request.headers.authorization);
    const upstream = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket);
    sockets.add(upstream);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    const address = server.address();
    mkdirSync(join(root, '.cat-cafe'));
    writeFileSync(
      join(root, '.cat-cafe/accounts.json'),
      JSON.stringify({
        11: {
          clientId: 'openai',
          authType: 'api_key',
          baseUrl: `https://127.0.0.1:${address.port}`,
          models: ['gpt-6'],
        },
      }),
    );
    writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify({ 11: { apiKey: fakeKey } }));
    writeFileSync(join(root, 'ref.png'), image);
    writeFileSync(join(root, 'prompt.txt'), 'stamp fixture');
    const requestFile = join(root, 'request.json');
    writeFileSync(
      requestFile,
      JSON.stringify({
        accountRef: '11',
        request: {
          method: 'POST',
          path: '/v1/images/edits',
          contentType: 'multipart/form-data',
          fields: {
            model: 'gpt-image-2.6-sunburst',
            prompt: { fromFile: 'prompt.txt' },
            tag: ['a', 'b'],
            frame_count: 16,
            complexity: 'high',
          },
          files: { image: { path: 'ref.png', contentType: 'image/png' } },
        },
      }),
    );
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CAT_CAFE_')));
    const child = spawn(
      process.execPath,
      [resolve('scripts/platform-request.mjs'), '--request', requestFile, '--output-dir', join(root, 'outputs')],
      {
        cwd: root,
        env: {
          ...inherited,
          NODE_ENV: 'test',
          LOG_DIR: join(root, 'logs'),
          AUDIT_LOG_DIR: join(root, 'audit'),
          CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
          NODE_EXTRA_CA_CERTS: cert,
          HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
          https_proxy: `http://127.0.0.1:${proxy.address().port}`,
          NO_PROXY: '',
          no_proxy: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
    });
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    assert.equal(`${stdout}${stderr}`.includes(fakeKey), false);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.requestId, 'fixture-real-https');
    assert.equal(receipt.status, 'completed');
    assert.deepEqual(receipt.usage, { input_tokens: 1455, output_tokens: 3568 });
    assert.equal(readFileSync(receipt.responseFile, 'utf8'), providerBody);
    assert.equal(observed.length, 1);
    assert.equal(proxyCalls, 1, 'the host proxy must be respected, not silently ignored');
    assert.equal(proxySawAuthentication, false, 'the account key belongs inside destination TLS');
    assert.deepEqual(observed[0], {
      path: '/v1/images/edits',
      authenticated: true,
      model: 'gpt-image-2.6-sunburst',
      tags: ['a', 'b'],
      prompt: 'stamp fixture',
      image,
    });
    assert.equal(readFileSync(receipt.receiptFile, 'utf8').includes(fakeKey), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
