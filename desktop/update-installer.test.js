// F273 — update-installer unit tests
// Tests: HTTP transport (downloadAsset) with mock net module.
// Covers: full download, resume, Content-Range mismatch rejection.

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { describe, test, beforeEach, afterEach } = require('node:test');

const { downloadAsset } = require('./update-installer');

// ── Mock helpers ───────────────────────────────────────────────────────

/** Create a mock Electron net.request that returns a canned response. */
function mockNet({ statusCode, headers, body }) {
  return {
    request(_url) {
      const req = new EventEmitter();
      req.setHeader = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.headers = headers || {};
        res.destroy = () => {};
        process.nextTick(() => {
          req.emit('response', res);
          if (body !== undefined) {
            const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
            process.nextTick(() => {
              res.emit('data', buf);
              process.nextTick(() => res.emit('end'));
            });
          }
        });
      };
      return req;
    },
  };
}

const noop = () => {};

// ── downloadAsset ──────────────────────────────────────────────────────

describe('downloadAsset', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'dl-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('200 full download writes file', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    const content = 'FULL_FILE_DATA_HERE';
    const net = mockNet({
      statusCode: 200,
      headers: { etag: '"abc"' },
      body: content,
    });

    await downloadAsset(net, { name: 'app.dmg', size: content.length }, dest, '0.10.0', noop, noop);

    assert.equal(readFileSync(dest, 'utf-8'), content);
    // meta file cleaned up after successful download
    assert.equal(existsSync(`${dest}.meta`), false);
  });

  test('206 resume with correct Content-Range appends', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    const partial = 'PARTIAL_';
    const rest = 'REST_DATA';

    // Simulate existing partial download + saved meta
    writeFileSync(dest, partial);
    writeFileSync(`${dest}.meta`, JSON.stringify({ etag: '"e1"' }));

    const net = mockNet({
      statusCode: 206,
      headers: {
        'content-range': `bytes ${partial.length}-${partial.length + rest.length - 1}/${partial.length + rest.length}`,
        etag: '"e1"',
      },
      body: rest,
    });

    await downloadAsset(net, { name: 'app.dmg', size: partial.length + rest.length }, dest, '0.10.0', noop, noop);

    assert.equal(readFileSync(dest, 'utf-8'), partial + rest);
  });

  test('206 with mismatched Content-Range rejects and cleans up', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    const partial = 'PARTIAL_16_BYTES';

    // Simulate existing partial + meta
    writeFileSync(dest, partial);
    writeFileSync(`${dest}.meta`, JSON.stringify({ etag: '"e1"' }));

    // Server responds with wrong start byte (50 instead of 16)
    const net = mockNet({
      statusCode: 206,
      headers: {
        'content-range': `bytes 50-61/112`,
        etag: '"e1"',
      },
      body: 'WRONG_SUFFIX',
    });

    await assert.rejects(
      () => downloadAsset(net, { name: 'app.dmg', size: 112 }, dest, '0.10.0', noop, noop),
      (err) => {
        assert.match(err.message, /Content-Range mismatch/);
        return true;
      },
    );

    // Partial file and meta must be deleted
    assert.equal(existsSync(dest), false, 'partial file should be deleted');
    assert.equal(existsSync(`${dest}.meta`), false, 'meta file should be deleted');
  });

  test('206 with missing Content-Range header rejects', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    writeFileSync(dest, 'PARTIAL');
    writeFileSync(`${dest}.meta`, JSON.stringify({ etag: '"e1"' }));

    const net = mockNet({
      statusCode: 206,
      headers: { etag: '"e1"' }, // no content-range
      body: 'DATA',
    });

    await assert.rejects(
      () => downloadAsset(net, { name: 'app.dmg', size: 100 }, dest, '0.10.0', noop, noop),
      (err) => {
        assert.match(err.message, /Content-Range mismatch/);
        return true;
      },
    );

    assert.equal(existsSync(dest), false);
    assert.equal(existsSync(`${dest}.meta`), false);
  });

  test('non-2xx status rejects', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    const net = mockNet({ statusCode: 404, headers: {} });

    await assert.rejects(
      () => downloadAsset(net, { name: 'app.dmg', size: 100 }, dest, '0.10.0', noop, noop),
      (err) => {
        assert.match(err.message, /HTTP 404/);
        return true;
      },
    );
  });

  test('206 with correct Content-Range but changed ETag rejects (AC-4)', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    const partial = 'PARTIAL_';

    writeFileSync(dest, partial);
    writeFileSync(`${dest}.meta`, JSON.stringify({ etag: '"old-etag"' }));

    // Server returns 206 with correct byte range but different ETag
    const net = mockNet({
      statusCode: 206,
      headers: {
        'content-range': `bytes ${partial.length}-15/16`,
        etag: '"new-etag"',
      },
      body: 'REST_NEW',
    });

    await assert.rejects(
      () => downloadAsset(net, { name: 'app.dmg', size: 16 }, dest, '0.10.0', noop, noop),
      (err) => {
        assert.match(err.message, /ETag mismatch/);
        return true;
      },
    );

    // Stale partial and meta must be deleted for clean retry
    assert.equal(existsSync(dest), false, 'stale partial should be deleted');
    assert.equal(existsSync(`${dest}.meta`), false, 'meta should be deleted');
  });

  test('request-level error rejects without ReferenceError (sol r4 P1)', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    // Mock that emits request-level error BEFORE any response
    const net = {
      request() {
        const req = new EventEmitter();
        req.setHeader = () => {};
        req.end = () => {
          process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
        };
        return req;
      },
    };

    await assert.rejects(
      () => downloadAsset(net, { name: 'app.dmg', size: 100 }, dest, '0.10.0', noop, noop),
      (err) => {
        assert.equal(err.message, 'ECONNREFUSED');
        return true;
      },
    );
  });

  test('refreshes and resolves the default-session proxy without overriding it', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    const calls = [];
    const logs = [];
    const session = {
      async forceReloadProxyConfig() {
        calls.push('reload');
      },
      async resolveProxy(url) {
        calls.push(['resolve', url]);
        return 'PROXY 127.0.0.1:7897';
      },
    };
    const net = mockNet({ statusCode: 200, headers: {}, body: 'OK' });

    await downloadAsset(
      net,
      {
        name: 'app.dmg',
        size: 2,
        browser_download_url: 'https://github.com/zts212653/clowder-ai/releases/download/v1/app.dmg',
      },
      dest,
      '0.10.0',
      noop,
      (line) => logs.push(line),
      { session },
    );

    assert.deepEqual(calls, [
      'reload',
      ['resolve', 'https://github.com/zts212653/clowder-ai/releases/download/v1/app.dmg'],
    ]);
    assert.ok(logs.includes('Download proxy: PROXY 127.0.0.1:7897'));
  });

  test('proxy diagnostics are best-effort and do not block the default-session request', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    const logs = [];
    const session = {
      async forceReloadProxyConfig() {
        throw new Error('proxy refresh unavailable');
      },
      async resolveProxy() {
        throw new Error('must not run after refresh failure');
      },
    };

    await downloadAsset(
      mockNet({ statusCode: 200, headers: {}, body: 'OK' }),
      { name: 'app.dmg', size: 2 },
      dest,
      '0.10.0',
      noop,
      (line) => logs.push(line),
      { session },
    );

    assert.equal(readFileSync(dest, 'utf8'), 'OK');
    assert.ok(logs.some((line) => line.includes('Proxy diagnostics unavailable')));
  });

  test('follows redirects synchronously and logs only safe destination metadata', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    const logs = [];
    let followedSynchronously = false;
    const signedRedirect =
      'https://release-assets.githubusercontent.com/github-production-release-asset/123/app.dmg?sp=r&sig=TOP_SECRET';
    const net = {
      request() {
        const req = new EventEmitter();
        req.setHeader = () => {};
        req.abort = () => {};
        req.followRedirect = () => {
          followedSynchronously = true;
        };
        req.end = () => {
          req.emit('redirect', 302, 'GET', signedRedirect, {});
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = {};
          res.destroy = () => {};
          process.nextTick(() => {
            req.emit('response', res);
            res.emit('data', Buffer.from('OK'));
            res.emit('end');
          });
        };
        return req;
      },
    };

    await downloadAsset(net, { name: 'app.dmg', size: 2 }, dest, '0.10.0', noop, (line) => logs.push(line));

    const logText = logs.join('\n');
    assert.equal(followedSynchronously, true, 'followRedirect must run inside the redirect event');
    assert.match(logText, /Redirect 302 GET -> release-assets\.githubusercontent\.com/);
    assert.doesNotMatch(logText, /TOP_SECRET|github-production-release-asset|sig=/);
  });

  test('request failure logs the transport phase and received byte count', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    const logs = [];
    const net = {
      request() {
        const req = new EventEmitter();
        req.setHeader = () => {};
        req.end = () => process.nextTick(() => req.emit('error', new Error('net::ERR_CONNECTION_CLOSED')));
        return req;
      },
    };

    await assert.rejects(
      () => downloadAsset(net, { name: 'app.dmg', size: 100 }, dest, '0.10.0', noop, (line) => logs.push(line)),
      /ERR_CONNECTION_CLOSED/,
    );

    assert.ok(logs.some((line) => line.includes('Download failed phase=request bytes=0: net::ERR_CONNECTION_CLOSED')));
  });

  test('stalled request (no response, no error) times out', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    // Mock that never emits 'response' or 'error' — simulates connection stall
    const net = {
      request() {
        const req = new EventEmitter();
        req.setHeader = () => {};
        req.end = () => {};
        return req;
      },
    };

    await assert.rejects(
      () => downloadAsset(net, { name: 'app.dmg', size: 100 }, dest, '0.10.0', noop, noop, 50),
      (err) => {
        assert.match(err.message, /timeout/i);
        return true;
      },
    );
  });

  test('timeout before response — late response discarded, no file created', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    const net = {
      request() {
        const req = new EventEmitter();
        req.setHeader = () => {};
        req.abort = () => {};
        req.end = () => {
          // Response arrives 100ms AFTER the 50ms timeout
          setTimeout(() => {
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = {};
            res.destroy = () => {};
            req.emit('response', res);
            process.nextTick(() => {
              res.emit('data', Buffer.from('LATE_BODY'));
              res.emit('end');
            });
          }, 100);
        };
        return req;
      },
    };
    await assert.rejects(
      () => downloadAsset(net, { name: 'app.dmg', size: 9 }, dest, '0.10.0', noop, noop, 50),
      /timeout/i,
    );
    // Wait for the late response to fire, then verify no file was created
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(existsSync(dest), false, 'late response must not create file');
  });

  test('mid-download timeout: writer closed, late data does not write or update progress', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    let destroyed = false;
    let aborted = false;
    let progressCount = 0;
    const net = {
      request() {
        const req = new EventEmitter();
        req.setHeader = () => {};
        let resRef;
        req.abort = () => {
          aborted = true;
          // Electron contract: abort() with active response triggers 'aborted'
          if (resRef) resRef.emit('aborted');
        };
        req.end = () => {
          process.nextTick(() => {
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = {};
            res.destroy = () => {
              destroyed = true;
            };
            resRef = res;
            req.emit('response', res);
            // First chunk before timeout
            process.nextTick(() => res.emit('data', Buffer.from('FIRST')));
            // Late chunk AFTER timeout — must not write or update progress
            setTimeout(() => {
              res.emit('data', Buffer.from('LATE'));
              res.emit('end');
            }, 100);
          });
        };
        return req;
      },
    };
    await assert.rejects(
      () => downloadAsset(net, { name: 'app.dmg', size: 10000 }, dest, '0.10.0', () => progressCount++, noop, 50),
      /timeout/i,
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(destroyed, 'response must be destroyed');
    assert.ok(aborted, 'request must be aborted');
    assert.equal(progressCount, 1, 'only pre-timeout chunk triggers progress');
    if (existsSync(dest)) {
      const content = readFileSync(dest, 'utf-8');
      assert.ok(!content.includes('LATE'), 'late data must not be in file');
    }
  });

  test('200 with existing partial overwrites (resume rejected by server)', async () => {
    const dest = path.join(tempDir, 'app.dmg');
    writeFileSync(dest, 'OLD_PARTIAL');
    writeFileSync(`${dest}.meta`, JSON.stringify({ etag: '"old"' }));

    const fullContent = 'BRAND_NEW_FULL_FILE';
    const net = mockNet({
      statusCode: 200, // server ignores Range, sends full
      headers: { etag: '"new"' },
      body: fullContent,
    });

    await downloadAsset(net, { name: 'app.dmg', size: fullContent.length }, dest, '0.10.0', noop, noop);

    assert.equal(readFileSync(dest, 'utf-8'), fullContent);
  });
});
