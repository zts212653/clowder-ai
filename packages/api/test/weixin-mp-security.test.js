/**
 * F197/F171: WeChat MP security boundary tests
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateExternalUrl } from '../dist/domains/weixin-mp/url-safety.js';
import { markdownToWxHtml } from '../dist/domains/weixin-mp/markdown-to-wx-html.js';

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

  it('rejects metadata.google.internal', () => {
    assert.throws(() => validateExternalUrl('http://metadata.google.internal/'), /blocked/);
  });

  it('rejects invalid URL', () => {
    assert.throws(() => validateExternalUrl('not-a-url'), /Invalid URL/);
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

  it('escapes HTML entities in attribute values', () => {
    const html = markdownToWxHtml('!["><script>](https://example.com/img.png)');
    assert.ok(!html.includes('"><script>'), 'attribute injection should be escaped');
  });
});
