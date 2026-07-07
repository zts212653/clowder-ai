// F257 — update-installer unit tests
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
