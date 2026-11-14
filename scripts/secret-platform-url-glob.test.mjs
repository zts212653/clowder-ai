import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

for (const entry of ['scripts/guarded-bin/curl', 'packages/mcp-server/dist/runtime/scripts/guarded-bin/curl'])
  test(`${entry} sends credentials only to the admitted literal URL and authority`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'platform-curl-glob-'));
    const cert = join(root, 'cert.pem');
    const key = join(root, 'tls-key.pem');
    const fakeKey = ['sk', 'proj', 'F317_GLOB_FIXTURE_'.repeat(4)].join('-');
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
    const requests = [];
    const receivedHeaders = [];
    const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      requests.push({ path: req.url, authenticated: req.headers.authorization === `Bearer ${fakeKey}` });
      receivedHeaders.push(req.headers);
      res.end('fixture response');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `https://127.0.0.1:${server.address().port}/api`;
      mkdirSync(join(root, '.cat-cafe'));
      const register = (baseUrl) =>
        writeFileSync(
          join(root, '.cat-cafe/accounts.json'),
          JSON.stringify({ relay: { clientId: 'openai', authType: 'api_key', baseUrl } }),
        );
      register(base);
      writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify({ relay: { apiKey: fakeKey } }));
      const run = async (suffix, extra = [], urlOption = false) => {
        const url = suffix.startsWith('https:') ? suffix : `${base}${suffix}`;
        const child = spawn(
          process.execPath,
          [
            resolve(entry),
            '-sS',
            '--max-time',
            '5',
            '--cacert',
            cert,
            '-H',
            `Authorization: Bearer ${fakeKey}`,
            ...extra,
            ...(urlOption ? ['--url', url] : [url]),
          ],
          {
            cwd: root,
            env: { PATH: `/usr/bin:/bin:${dirname(process.execPath)}`, HOME: root, CAT_CAFE_GLOBAL_CONFIG_ROOT: root },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout.on('data', (bytes) => {
          output += bytes;
        });
        child.stderr.on('data', (bytes) => {
          output += bytes;
        });
        const [status] = await once(child, 'close');
        assert.equal(output.includes(fakeKey), false);
        return { status, output };
      };
      await t.test('rejects URLs that WHATWG and curl parse as different origins', async () => {
        register('https://approved.example');
        requests.length = 0;
        try {
          const result = await run(`https://approved.example\\@127.0.0.1:${server.address().port}/api/safe`);
          assert.deepEqual(requests, [], 'the unregistered HTTPS server must never receive the bearer');
          assert.equal(result.status, 1, result.output);
        } finally {
          register(base);
        }
      });
      await t.test('rejects authority and authentication overrides inside header files', async () => {
        const headers = join(root, 'headers.txt');
        for (const content of ['Host: other-tenant.example\n', 'Authorization: Bearer replacement\n']) {
          writeFileSync(headers, content);
          requests.length = 0;
          const result = await run('/safe', ['-H', `@${headers}`]);
          assert.deepEqual(requests, [], 'frozen headers must be checked before any authenticated transfer');
          assert.equal(result.status, 1, result.output);
        }
      });
      await t.test('preserves ordinary file headers and sends the validated canonical URL', async () => {
        const headers = join(root, 'headers.txt');
        writeFileSync(headers, 'OpenAI-Project: fixture-project\r\nOpenAI-Beta: fixture-beta\r\n');
        requests.length = 0;
        receivedHeaders.length = 0;
        for (const urlOption of [false, true]) {
          requests.length = 0;
          receivedHeaders.length = 0;
          const result = await run('/猫?q=one two', ['--header', `@${headers}`], urlOption);
          assert.equal(result.status, 0, result.output);
          assert.deepEqual(requests, [{ path: '/api/%E7%8C%AB?q=one%20two', authenticated: true }]);
          assert.equal(receivedHeaders[0]['openai-project'], 'fixture-project');
          assert.equal(receivedHeaders[0]['openai-beta'], 'fixture-beta');
        }
      });
      await t.test('rejects inline header injection and semicolon authority overrides', async () => {
        const injection = 'value\r\nHost: other-tenant.example';
        for (const extra of [
          ['-H', `X-Test: ${injection}`],
          ['-H', 'Host;'],
          ['-H', 'Authorization;'],
          ['-A', injection],
          ['-e', injection],
          ['-r', injection],
          ['-X', injection],
        ]) {
          requests.length = 0;
          const result = await run('/safe', extra);
          assert.deepEqual(requests, [], 'supplemental headers cannot change the admitted authority or auth');
          assert.equal(result.status, 1, result.output);
        }
      });
      await t.test('keeps URL sequences and ranges within one literal transfer', async () => {
        for (const suffix of ['/{../outside,safe}', '/frame[1-2]', '/search?q={one,two}']) {
          requests.length = 0;
          const result = await run(suffix);
          assert.equal(result.status, 0, result.output);
          assert.deepEqual(
            requests,
            [{ path: new URL(`${base}${suffix}`).pathname + new URL(`${base}${suffix}`).search, authenticated: true }],
            'one accepted URL must cause exactly one literal transfer, never /outside or an expanded range',
          );
        }
        requests.length = 0;
        assert.equal((await run('/{../outside,safe}', ['--no-globoff'])).status, 1);
        assert.deepEqual(requests, [], 'callers cannot re-enable expansion after destination admission');
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
