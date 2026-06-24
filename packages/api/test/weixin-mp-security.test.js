/**
 * F197/F171: WeChat MP security boundary tests
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { describe, it } from 'node:test';
import { markdownToWxHtml } from '../dist/plugins/weixin-mp/markdown-to-wx-html.js';
import {
  createPinnedRequestOptions,
  fetchExternalUrlPinned,
  resolveExternalUrl,
  validateExternalUrl,
  validateExternalUrlResolved,
} from '../dist/utils/url-safety.js';

describe('validateExternalUrl', () => {
  it('allows https URLs', () => {
    assert.doesNotThrow(() => validateExternalUrl('https://example.com/image.png'));
  });

  it('allows http URLs', () => {
    assert.doesNotThrow(() => validateExternalUrl('http://example.com/image.png'));
  });

  it('rejects javascript: protocol', () => {
    assert.throws(() => validateExternalUrl('javascript:alert(1)'), /http or https/);
  });

  it('rejects data: protocol', () => {
    assert.throws(() => validateExternalUrl('data:text/html,<script>'), /http or https/);
  });

  it('rejects file: protocol', () => {
    assert.throws(() => validateExternalUrl('file:///etc/passwd'), /http or https/);
  });

  it('rejects localhost', () => {
    assert.throws(() => validateExternalUrl('http://localhost/secret'), /blocked/);
  });

  it('rejects 127.0.0.1', () => {
    assert.throws(() => validateExternalUrl('http://127.0.0.1/secret'), /private/);
  });

  it('rejects 10.x private IP', () => {
    assert.throws(() => validateExternalUrl('http://10.0.0.1/internal'), /private/);
  });

  it('rejects 192.168.x private IP', () => {
    assert.throws(() => validateExternalUrl('http://192.168.1.1/router'), /private/);
  });

  it('rejects 169.254.169.254 metadata IP', () => {
    assert.throws(() => validateExternalUrl('http://169.254.169.254/latest/meta-data'), /private/);
  });

  it('rejects carrier-grade NAT addresses', () => {
    assert.throws(() => validateExternalUrl('http://100.64.0.1/internal'), /private/);
    assert.throws(() => validateExternalUrl('http://100.127.255.254/internal'), /private/);
  });

  it('rejects benchmark network addresses', () => {
    assert.throws(() => validateExternalUrl('http://198.18.0.1/internal'), /private/);
    assert.throws(() => validateExternalUrl('http://198.19.255.254/internal'), /private/);
  });

  it('rejects metadata.google.internal', () => {
    assert.throws(() => validateExternalUrl('http://metadata.google.internal/'), /blocked/);
  });

  it('rejects invalid URL', () => {
    assert.throws(() => validateExternalUrl('not-a-url'), /Invalid URL/);
  });

  it('rejects IPv6-mapped IPv4 loopback', () => {
    assert.throws(() => validateExternalUrl('http://[::ffff:127.0.0.1]/secret'), /private/);
  });

  it('rejects trailing-dot metadata hostname', () => {
    assert.throws(() => validateExternalUrl('http://metadata.google.internal./'), /blocked/);
  });

  it('rejects trailing-dot localhost', () => {
    assert.throws(() => validateExternalUrl('http://localhost./secret'), /blocked/);
  });

  it('rejects IPv6-mapped private IP', () => {
    assert.throws(() => validateExternalUrl('http://[::ffff:169.254.169.254]/meta'), /private/);
  });

  it('rejects IPv4-compatible IPv6 private IP literals', () => {
    assert.throws(() => validateExternalUrl('http://[::127.0.0.1]/secret'), /private/);
    assert.throws(() => validateExternalUrl('http://[::7f00:1]/secret'), /private/);
  });

  it('rejects IPv4-translated IPv6 private IP literals', () => {
    assert.throws(() => validateExternalUrl('http://[::ffff:0:127.0.0.1]/secret'), /private/);
    assert.throws(() => validateExternalUrl('http://[::ffff:0:7f00:1]/secret'), /private/);
  });

  it('rejects site-local IPv6 addresses', () => {
    assert.throws(() => validateExternalUrl('http://[fec0::1]/secret'), /private/);
    assert.throws(() => validateExternalUrl('http://[feff::1]/secret'), /private/);
  });

  it('rejects local-use IPv6 translation addresses', () => {
    assert.throws(() => validateExternalUrl('http://[64:ff9b:1::a9fe:a9fe]/secret'), /private/);
  });

  it('allows hostnames that resolve to public addresses', async () => {
    await assert.doesNotReject(() =>
      validateExternalUrlResolved('https://cdn.example.test/image.png', async () => [{ address: '93.184.216.34' }]),
    );
  });

  it('rejects hostnames that resolve to private IPv4 addresses', async () => {
    await assert.rejects(
      () => validateExternalUrlResolved('https://cdn.example.test/image.png', async () => [{ address: '10.0.0.5' }]),
      /private/,
    );
  });

  it('rejects hostnames that resolve to non-public IPv4 addresses', async () => {
    await assert.rejects(
      () => validateExternalUrlResolved('https://cdn.example.test/image.png', async () => [{ address: '100.64.0.1' }]),
      /private/,
    );
    await assert.rejects(
      () => validateExternalUrlResolved('https://cdn.example.test/image.png', async () => [{ address: '198.18.0.1' }]),
      /private/,
    );
  });

  it('rejects hostnames that resolve to metadata addresses', async () => {
    await assert.rejects(
      () =>
        validateExternalUrlResolved('https://cdn.example.test/image.png', async () => [
          { address: '93.184.216.34' },
          { address: '169.254.169.254' },
        ]),
      /private/,
    );
  });

  it('rejects hostnames that resolve to private IPv6 addresses', async () => {
    await assert.rejects(
      () => validateExternalUrlResolved('https://cdn.example.test/image.png', async () => [{ address: 'fd00::1' }]),
      /private/,
    );
  });

  it('rejects hostnames that resolve to site-local IPv6 addresses', async () => {
    await assert.rejects(
      () => validateExternalUrlResolved('https://cdn.example.test/image.png', async () => [{ address: 'fec0::1' }]),
      /private/,
    );
  });

  it('rejects hostnames that resolve to local-use IPv6 translation addresses', async () => {
    await assert.rejects(
      () =>
        validateExternalUrlResolved('https://cdn.example.test/image.png', async () => [
          { address: '64:ff9b:1::a9fe:a9fe' },
        ]),
      /private/,
    );
  });

  it('pins fetch request options to the validated DNS address', async () => {
    const resolved = await resolveExternalUrl('https://cdn.example.test:8443/image.png?size=large', async () => [
      { address: '93.184.216.34' },
    ]);

    const options = createPinnedRequestOptions(resolved);

    assert.equal(options.hostname, '93.184.216.34');
    assert.equal(options.servername, 'cdn.example.test');
    assert.equal(options.path, '/image.png?size=large');
    assert.deepEqual(options.headers, { Host: 'cdn.example.test:8443' });
  });

  it('rejects slow-drip image responses after the wall-clock timeout', async () => {
    const originalRequest = http.request;
    let fakeReq;

    http.request = (_options, onResponse) => {
      const req = new EventEmitter();
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { 'content-type': 'image/png' };
      res.resume = () => {};
      res.destroy = () => {};
      req.setTimeout = () => req;
      req.end = () => {
        queueMicrotask(() => {
          onResponse(res);
          res.emit('data', Buffer.from([1]));
        });
      };
      req.destroy = (err) => {
        req.destroyedWith = err;
        req.emit('error', err);
        res.emit('error', err);
      };
      fakeReq = req;
      return req;
    };

    try {
      const fetchPromise = fetchExternalUrlPinned('http://cdn.example.test/image.png', {
        timeoutMs: 20,
        maxBytes: 1024,
        dnsLookup: async () => [{ address: '93.184.216.34' }],
      });
      const result = await Promise.race([
        fetchPromise.then(
          () => ({ status: 'resolved' }),
          (err) => ({ status: 'rejected', err }),
        ),
        new Promise((resolve) => setTimeout(() => resolve({ status: 'pending' }), 80)),
      ]);

      if (result.status === 'pending') {
        fakeReq?.destroy(new Error('cleanup'));
        await fetchPromise.catch(() => {});
      }

      assert.equal(result.status, 'rejected');
      assert.match(result.err.message, /timed out after 20ms/);
      assert.match(fakeReq.destroyedWith.message, /timed out after 20ms/);
    } finally {
      http.request = originalRequest;
    }
  });

  it('rejects stalled DNS resolution after the wall-clock timeout', async () => {
    const originalRequest = http.request;
    let requestCalled = false;

    http.request = () => {
      requestCalled = true;
      throw new Error('request should not start before DNS timeout');
    };

    try {
      const fetchPromise = fetchExternalUrlPinned('http://cdn.example.test/image.png', {
        timeoutMs: 20,
        maxBytes: 1024,
        dnsLookup: async () => new Promise(() => {}),
      });

      const result = await Promise.race([
        fetchPromise.then(
          () => ({ status: 'resolved' }),
          (err) => ({ status: 'rejected', err }),
        ),
        new Promise((resolve) => setTimeout(() => resolve({ status: 'pending' }), 80)),
      ]);

      assert.equal(result.status, 'rejected');
      assert.match(result.err.message, /timed out after 20ms/);
      assert.equal(requestCalled, false);
    } finally {
      http.request = originalRequest;
    }
  });
});

describe('markdownToWxHtml sanitization', () => {
  it('escapes HTML tags in text', () => {
    const html = markdownToWxHtml('<script>alert(1)</script>');
    assert.ok(!html.includes('<script>'), 'script tag should be escaped');
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('escapes quote breakout in img alt text', () => {
    const html = markdownToWxHtml('![x" onerror="alert(1)](https://example.com/img.png)');
    assert.ok(!html.includes('onerror="alert'), 'attribute breakout should be escaped');
    assert.ok(html.includes('&amp;quot;') || html.includes('&quot;'), 'quotes should be entity-escaped');
  });

  it('blocks javascript: URLs in links', () => {
    const html = markdownToWxHtml('[click](javascript:alert(1))');
    assert.ok(!html.includes('javascript:'), 'javascript: should be stripped');
  });

  it('blocks javascript: URLs in images', () => {
    const html = markdownToWxHtml('![img](javascript:alert(1))');
    assert.ok(!html.includes('javascript:'), 'javascript: should be stripped');
  });

  it('allows https URLs in links', () => {
    const html = markdownToWxHtml('[click](https://example.com)');
    assert.ok(html.includes('href="https://example.com"'));
  });

  it('escapes query-string ampersands once in image URLs', () => {
    const html = markdownToWxHtml('![cdn](https://cdn.example.com/img.jpg?token=a&sig=b)');
    assert.ok(html.includes('src="https://cdn.example.com/img.jpg?token=a&amp;sig=b"'));
    assert.ok(!html.includes('&amp;amp;'));
  });

  it('escapes query-string ampersands once in link URLs', () => {
    const html = markdownToWxHtml('[cdn](https://cdn.example.com/page?token=a&sig=b)');
    assert.ok(html.includes('href="https://cdn.example.com/page?token=a&amp;sig=b"'));
    assert.ok(!html.includes('&amp;amp;'));
  });

  it('escapes HTML entities in attribute values', () => {
    const html = markdownToWxHtml('!["><script>](https://example.com/img.png)');
    assert.ok(!html.includes('"><script>'), 'attribute injection should be escaped');
  });

  it('blocks protocol-relative URLs in links', () => {
    const html = markdownToWxHtml('[click](//evil.test/path)');
    assert.ok(!html.includes('href="//evil.test'), 'protocol-relative URL should be stripped');
  });

  it('blocks protocol-relative URLs in images', () => {
    const html = markdownToWxHtml('![img](//evil.test/img.png)');
    assert.ok(!html.includes('src="//evil.test'), 'protocol-relative URL should be stripped');
  });
});
