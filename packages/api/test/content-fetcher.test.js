import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createFetchContentFn,
  extractText,
  needsBrowser,
  validateUrl,
} from '../dist/infrastructure/scheduler/content-fetcher.js';

describe('content-fetcher', () => {
  describe('needsBrowser', () => {
    it('returns true for x.com URLs', () => {
      assert.equal(needsBrowser('https://x.com/user/status/123'), true);
      assert.equal(needsBrowser('https://www.x.com/user'), true);
    });

    it('returns true for twitter.com URLs', () => {
      assert.equal(needsBrowser('https://twitter.com/user/status/123'), true);
    });

    it('returns true for xiaohongshu URLs', () => {
      assert.equal(needsBrowser('https://www.xiaohongshu.com/explore'), true);
    });

    it('returns true for bilibili URLs', () => {
      assert.equal(needsBrowser('https://www.bilibili.com/video/BV123'), true);
    });

    it('returns true for douyin URLs', () => {
      assert.equal(needsBrowser('https://www.douyin.com/video/123'), true);
    });

    it('returns true for instagram URLs', () => {
      assert.equal(needsBrowser('https://www.instagram.com/p/ABC'), true);
    });

    it('returns true for threads.net URLs', () => {
      assert.equal(needsBrowser('https://www.threads.net/@user/post/abc'), true);
    });

    it('returns false for simple sites', () => {
      assert.equal(needsBrowser('https://example.com/article'), false);
      assert.equal(needsBrowser('https://blog.anthropic.com/news'), false);
      assert.equal(needsBrowser('https://news.ycombinator.com'), false);
    });
  });

  describe('extractText', () => {
    it('extracts title from HTML', () => {
      const html = '<html><head><title>Test Page</title></head><body>Hello</body></html>';
      const { title, text } = extractText(html);
      assert.equal(title, 'Test Page');
      assert.ok(text.includes('Hello'));
    });

    it('strips script and style tags', () => {
      const html = '<script>alert("x")</script><style>.a{}</style><p>Content</p>';
      const { text } = extractText(html);
      assert.ok(!text.includes('alert'));
      assert.ok(!text.includes('.a'));
      assert.ok(text.includes('Content'));
    });

    it('collapses whitespace', () => {
      const html = '<p>Hello   \n\n   World</p>';
      const { text } = extractText(html);
      assert.equal(text, 'Hello World');
    });

    it('returns empty title when none present', () => {
      const html = '<p>No title</p>';
      const { title } = extractText(html);
      assert.equal(title, '');
    });
  });

  describe('validateUrl (SSRF protection)', () => {
    it('allows public HTTP URLs', () => {
      assert.doesNotThrow(() => validateUrl('https://example.com/article'));
      assert.doesNotThrow(() => validateUrl('http://blog.anthropic.com'));
    });

    it('blocks non-HTTP protocols', () => {
      assert.throws(() => validateUrl('file:///etc/passwd'), /blocked/i);
      assert.throws(() => validateUrl('ftp://internal.server/data'), /blocked/i);
      assert.throws(() => validateUrl('gopher://evil.host'), /blocked/i);
    });

    it('blocks localhost', () => {
      assert.throws(() => validateUrl('http://localhost/api'), /blocked/i);
      assert.throws(() => validateUrl('http://localhost:3004/api'), /blocked/i);
    });

    it('blocks loopback addresses', () => {
      assert.throws(() => validateUrl('http://127.0.0.1/secret'), /blocked/i);
      assert.throws(() => validateUrl('http://[::1]/api'), /blocked/i);
    });

    it('blocks private IP ranges', () => {
      assert.throws(() => validateUrl('http://10.0.0.1/internal'), /blocked/i);
      assert.throws(() => validateUrl('http://172.16.0.1/admin'), /blocked/i);
      assert.throws(() => validateUrl('http://192.168.1.1/config'), /blocked/i);
    });

    it('blocks link-local and metadata addresses', () => {
      assert.throws(() => validateUrl('http://169.254.169.254/latest/meta-data/'), /blocked/i);
    });

    it('blocks DNS aliases for localhost', () => {
      assert.throws(() => validateUrl('http://localhost.localdomain/api'), /blocked/i);
      assert.throws(() => validateUrl('http://sub.localhost/api'), /blocked/i);
    });

    it('blocks full IPv6 link-local range fe80::/10 (fe80-febf)', () => {
      assert.throws(() => validateUrl('http://[fe80::1]/api'), /blocked/i);
      assert.throws(() => validateUrl('http://[fe90::1]/api'), /blocked/i);
      assert.throws(() => validateUrl('http://[fea0::1]/api'), /blocked/i);
      assert.throws(() => validateUrl('http://[febf::1]/api'), /blocked/i);
    });

    it('blocks full IPv6 ULA range fc00::/7 (fc00-fdff)', () => {
      assert.throws(() => validateUrl('http://[fd12::1]/api'), /blocked/i);
      assert.throws(() => validateUrl('http://[fc00::1]/api'), /blocked/i);
      assert.throws(() => validateUrl('http://[fcab::1]/api'), /blocked/i);
    });

    it('blocks IPv4-mapped IPv6 addresses (::ffff:)', () => {
      assert.throws(() => validateUrl('http://[::ffff:127.0.0.1]/api'), /blocked/i);
      assert.throws(() => validateUrl('http://[::ffff:7f00:1]/api'), /blocked/i);
      assert.throws(() => validateUrl('http://[::ffff:10.0.0.1]/api'), /blocked/i);
      assert.throws(() => validateUrl('http://[::ffff:a9fe:a9fe]/api'), /blocked/i);
      assert.throws(() => validateUrl('http://[::ffff:c0a8:1]/api'), /blocked/i);
    });
  });

  describe('createFetchContentFn SSRF integration', () => {
    it('rejects internal URLs before making fetch call', async () => {
      const fetchContent = createFetchContentFn();
      await assert.rejects(() => fetchContent('http://127.0.0.1/secret'), /blocked/i);
      await assert.rejects(() => fetchContent('file:///etc/passwd'), /blocked/i);
    });
  });
});
