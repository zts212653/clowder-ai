// F273 — fetchReleases unit tests (sol re-review: P1 timer scoping + full failure-mode sweep)
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, test } = require('node:test');

const { fetchReleases } = require('./update-installer');

// ── Mock helpers ───────────────────────────────────────────────────────

function mockNet({ statusCode, headers, body, delay, requestError, throwOnRequest }) {
  return {
    request(_url) {
      if (throwOnRequest) throw throwOnRequest;
      const req = new EventEmitter();
      req.setHeader = () => {};
      req.abort = () => {};
      req.end = () => {
        if (requestError) {
          process.nextTick(() => req.emit('error', requestError));
          return;
        }
        const emit = () => {
          const res = new EventEmitter();
          res.statusCode = statusCode;
          res.headers = headers || {};
          res.destroy = () => {};
          req.emit('response', res);
          if (body !== undefined) {
            const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
            process.nextTick(() => {
              res.emit('data', buf);
              process.nextTick(() => res.emit('end'));
            });
          }
        };
        if (delay) setTimeout(emit, delay);
        else process.nextTick(emit);
      };
      return req;
    },
  };
}

function mockNetResponseEvents({ statusCode, headers, emitFn }) {
  return {
    request(_url) {
      const req = new EventEmitter();
      req.setHeader = () => {};
      req.abort = () => {};
      req.end = () => {
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = statusCode;
          res.headers = headers || {};
          res.destroy = () => {};
          req.emit('response', res);
          if (emitFn) process.nextTick(() => emitFn(res));
        });
      };
      return req;
    },
  };
}

/** Net that never emits response (for stall/timeout tests). */
function stallNet() {
  return {
    request(_url) {
      const req = new EventEmitter();
      req.setHeader = () => {};
      req.abort = () => {};
      req.end = () => {}; // never emits response
      return req;
    },
  };
}

// ── fetchReleases ─────────────────────────────────────────────────────

describe('fetchReleases', () => {
  test('200 with valid JSON returns { data, etag }', async () => {
    const releases = [{ tag_name: 'v0.12.0' }];
    const net = mockNet({
      statusCode: 200,
      headers: { etag: '"abc123"' },
      body: JSON.stringify(releases),
    });
    const result = await fetchReleases(net, '0.10.0', null, 5000);
    assert.deepEqual(result.data, releases);
    assert.equal(result.etag, '"abc123"');
  });

  test('304 returns "not-modified"', async () => {
    const net = mockNet({ statusCode: 304, body: undefined });
    const result = await fetchReleases(net, '0.10.0', '"old-etag"', 5000);
    assert.equal(result, 'not-modified');
  });

  test('non-200/304 returns null', async () => {
    const net = mockNet({ statusCode: 500, body: 'Server Error' });
    const result = await fetchReleases(net, '0.10.0', null, 5000);
    assert.equal(result, null);
  });

  test('invalid JSON body returns null', async () => {
    const net = mockNet({ statusCode: 200, headers: {}, body: '{{not json' });
    const result = await fetchReleases(net, '0.10.0', null, 5000);
    assert.equal(result, null);
  });

  test('request-level error returns null', async () => {
    const net = mockNet({ requestError: new Error('DNS failure') });
    const result = await fetchReleases(net, '0.10.0', null, 5000);
    assert.equal(result, null);
  });

  test('net.request() throws synchronously returns null', async () => {
    const net = mockNet({ throwOnRequest: new Error('net not ready') });
    const result = await fetchReleases(net, '0.10.0', null, 5000);
    assert.equal(result, null);
  });

  test('response error event returns null', async () => {
    const net = mockNetResponseEvents({
      statusCode: 200,
      headers: {},
      emitFn: (res) => res.emit('error', new Error('connection reset')),
    });
    const result = await fetchReleases(net, '0.10.0', null, 5000);
    assert.equal(result, null);
  });

  test('response aborted event returns null', async () => {
    const net = mockNetResponseEvents({
      statusCode: 200,
      headers: {},
      emitFn: (res) => res.emit('aborted'),
    });
    const result = await fetchReleases(net, '0.10.0', null, 5000);
    assert.equal(result, null);
  });

  test('stalled request (no response, no error) times out', async () => {
    const net = stallNet();
    const start = Date.now();
    const result = await fetchReleases(net, '0.10.0', null, 100);
    const elapsed = Date.now() - start;
    assert.equal(result, null);
    assert.ok(elapsed >= 90, `expected >=90ms, got ${elapsed}ms`);
  });

  test('late response after timeout is destroyed', async () => {
    let lateResponseDestroyed = false;
    const net = {
      request(_url) {
        const req = new EventEmitter();
        req.setHeader = () => {};
        req.abort = () => {};
        req.end = () => {
          // Emit response AFTER timeout fires
          setTimeout(() => {
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = {};
            res.destroy = () => {
              lateResponseDestroyed = true;
            };
            req.emit('response', res);
          }, 200);
        };
        return req;
      },
    };
    const result = await fetchReleases(net, '0.10.0', null, 50);
    assert.equal(result, null);
    // Wait for late response to arrive
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(lateResponseDestroyed, 'late response should be destroyed');
  });

  test('200 with missing etag header returns null etag', async () => {
    const net = mockNet({
      statusCode: 200,
      headers: {},
      body: JSON.stringify([]),
    });
    const result = await fetchReleases(net, '0.10.0', null, 5000);
    assert.deepEqual(result.data, []);
    assert.equal(result.etag, null);
  });
});
