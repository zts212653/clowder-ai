/**
 * MCP Web Fetch Tools Tests
 * 测试 cat_cafe_web_fetch 的网页抓取、HTML 清理、错误处理。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP Web Fetch Tools', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('handleWebFetch returns title and plain text from HTML', async () => {
    const { handleWebFetch } = await import('../dist/tools/web-fetch-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      url: 'https://example.com',
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' }),
      text: async () =>
        '<html><head><title>Hello World</title></head><body>' +
        '<script>var x=1;</script><style>.a{color:red}</style>' +
        '<p>Some &amp; content here.</p></body></html>',
    });

    const result = await handleWebFetch({ url: 'https://example.com' });

    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('URL: https://example.com'));
    assert.ok(text.includes('Status: 200'));
    assert.ok(text.includes('Title: Hello World'));
    assert.ok(text.includes('Some & content here.'));
    // Script and style content should be stripped
    assert.ok(!text.includes('var x=1'));
    assert.ok(!text.includes('color:red'));
  });

  test('handleWebFetch normalizes URL without protocol', async () => {
    const { handleWebFetch } = await import('../dist/tools/web-fetch-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        url,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/plain' }),
        text: async () => 'plain content',
      };
    };

    await handleWebFetch({ url: 'example.com/page' });
    assert.equal(capturedUrl, 'https://example.com/page');
  });

  test('handleWebFetch returns error for empty URL', async () => {
    const { handleWebFetch } = await import('../dist/tools/web-fetch-tools.js');

    const result = await handleWebFetch({ url: '' });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('empty'));
  });

  test('handleWebFetch truncates long content', async () => {
    const { handleWebFetch } = await import('../dist/tools/web-fetch-tools.js');

    const longText = 'A'.repeat(60000);
    globalThis.fetch = async () => ({
      ok: true,
      url: 'https://example.com',
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/plain' }),
      text: async () => longText,
    });

    const result = await handleWebFetch({ url: 'https://example.com', max_chars: 1000 });
    const text = result.content[0].text;
    assert.ok(text.includes('...[truncated]'));
    // Content line should be at most ~1000 chars + truncation marker
    const contentLine = text.split('Content:\n')[1];
    assert.ok(contentLine.length < 1100);
  });

  test('handleWebFetch falls back to Jina on 403', async () => {
    const { handleWebFetch } = await import('../dist/tools/web-fetch-tools.js');

    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount++;
      if (callCount === 1) {
        // First call returns 403
        return {
          ok: false,
          url,
          status: 403,
          statusText: 'Forbidden',
          headers: new Headers(),
          text: async () => 'Forbidden',
        };
      }
      // Second call is Jina reader
      assert.ok(String(url).includes('r.jina.ai/'));
      return {
        ok: true,
        url,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/plain' }),
        text: async () => 'Jina reader content',
      };
    };

    const result = await handleWebFetch({ url: 'https://blocked.com' });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Jina reader content'));
    assert.equal(callCount, 2);
  });

  test('handleWebFetch returns error on network failure', async () => {
    const { handleWebFetch } = await import('../dist/tools/web-fetch-tools.js');

    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await handleWebFetch({ url: 'https://example.com' });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('ECONNREFUSED'));
  });

  test('handleWebFetch clamps max_chars and timeout_seconds', async () => {
    const { handleWebFetch } = await import('../dist/tools/web-fetch-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      url: 'https://example.com',
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/plain' }),
      text: async () => 'B'.repeat(100),
    });

    // max_chars below minimum should still work (clamped to 500)
    const result = await handleWebFetch({
      url: 'https://example.com',
      max_chars: 1,
      timeout_seconds: 1,
    });
    assert.equal(result.isError, undefined);
  });

  test('handleWebFetch decodes DuckDuckGo redirect', async () => {
    const { handleWebFetch } = await import('../dist/tools/web-fetch-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        url,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/plain' }),
        text: async () => 'content',
      };
    };

    await handleWebFetch({
      url: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal-site.com%2Fpage',
    });
    assert.equal(capturedUrl, 'https://real-site.com/page');
  });
});
