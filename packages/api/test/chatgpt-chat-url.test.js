/**
 * F247 AC-B1c-11: ChatGPT chat URL validator unit tests.
 *
 * Defense against db-write injection — only canonical `https://chatgpt.com/c/<id>`
 * shaped URLs are accepted as `cloudCatBindings` values.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHATGPT_CHAT_URL_REGEX, isValidChatGptChatUrl } from '../dist/utils/chatgpt-chat-url.js';

describe('F247 AC-B1c-11: ChatGPT chat URL validator', () => {
  describe('canonical accept', () => {
    it('accepts standard UUID chat URL', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/6a3e13fb-5dc4-83e8-aaed-b494abc0ac22'), true);
    });

    it('accepts trailing slash', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/6a3e13fb-5dc4-83e8-aaed-b494abc0ac22/'), true);
    });

    it('accepts shorter id', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/abc'), true);
    });

    it('accepts numeric-only id', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/12345'), true);
    });
  });

  describe('reject — wrong scheme', () => {
    it('rejects http://', () => {
      assert.equal(isValidChatGptChatUrl('http://chatgpt.com/c/abc'), false);
    });

    it('rejects scheme-less', () => {
      assert.equal(isValidChatGptChatUrl('chatgpt.com/c/abc'), false);
    });

    it('rejects file://', () => {
      assert.equal(isValidChatGptChatUrl('file:///chatgpt.com/c/abc'), false);
    });
  });

  describe('reject — wrong host', () => {
    it('rejects different domain', () => {
      assert.equal(isValidChatGptChatUrl('https://evil.com/c/abc'), false);
    });

    it('rejects subdomain attempt', () => {
      assert.equal(isValidChatGptChatUrl('https://evil.chatgpt.com/c/abc'), false);
    });

    it('rejects chatgpt.com prefix attack', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com.evil.com/c/abc'), false);
    });

    it('rejects userinfo attack', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com@evil.com/c/abc'), false);
    });
  });

  describe('reject — wrong path', () => {
    it('rejects root path', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/'), false);
    });

    it('rejects /c/ without id', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/'), false);
    });

    it('rejects /settings path', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/settings/Personalization'), false);
    });

    it('rejects path beyond /c/<id>', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/abc/extra'), false);
    });
  });

  describe('reject — query / hash / injection', () => {
    it('rejects query string', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/abc?evil=true'), false);
    });

    it('rejects hash fragment (KD-21 spike saw #settings/Personalization leak)', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/abc#settings/Personalization'), false);
    });

    it('rejects invalid id chars (slash)', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/a/b'), false);
    });

    it('rejects invalid id chars (dot)', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/a.b'), false);
    });

    it('rejects whitespace in id', () => {
      assert.equal(isValidChatGptChatUrl('https://chatgpt.com/c/abc def'), false);
    });
  });

  describe('reject — non-string', () => {
    it('rejects undefined', () => {
      assert.equal(isValidChatGptChatUrl(undefined), false);
    });

    it('rejects null', () => {
      assert.equal(isValidChatGptChatUrl(null), false);
    });

    it('rejects empty string', () => {
      assert.equal(isValidChatGptChatUrl(''), false);
    });

    it('rejects object', () => {
      assert.equal(isValidChatGptChatUrl({ url: 'https://chatgpt.com/c/abc' }), false);
    });
  });

  describe('regex export', () => {
    it('regex is exported as canonical pattern', () => {
      assert.equal(CHATGPT_CHAT_URL_REGEX.test('https://chatgpt.com/c/abc'), true);
    });
  });
});
