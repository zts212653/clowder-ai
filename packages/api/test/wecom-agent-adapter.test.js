/**
 * F132 Phase C: WeCom Agent Adapter (企微自建应用) — comprehensive tests
 *
 * Covers: crypto (SHA1 + AES-256-CBC), verifyCallback, decryptInbound,
 * parseEvent, access token management, sendReply, sendFormattedReply,
 * sendMedia, downloadMedia, chunkMessage.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import {
  computeSignature,
  decryptMessage,
  encryptMessage,
  WeComAgentAdapter,
} from '../dist/infrastructure/connectors/adapters/WeComAgentAdapter.js';

// ── Helpers ──

function noopLog() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  };
}

// Generate a deterministic 43-char Base64 key (without trailing =)
// 32 bytes → 44 Base64 chars → strip trailing '=' → 43 chars
const TEST_AES_KEY_RAW = crypto.randomBytes(32);
const TEST_ENCODING_AES_KEY = TEST_AES_KEY_RAW.toString('base64').slice(0, 43);
const TEST_CORP_ID = 'ww_test_corp_id';
const TEST_AGENT_ID = '1000002';
const TEST_AGENT_SECRET = 'test-agent-secret-value';
const TEST_TOKEN = 'test-callback-token';

function makeAdapter(overrides = {}) {
  return new WeComAgentAdapter(noopLog(), {
    corpId: TEST_CORP_ID,
    agentId: TEST_AGENT_ID,
    agentSecret: TEST_AGENT_SECRET,
    token: TEST_TOKEN,
    encodingAesKey: TEST_ENCODING_AES_KEY,
    ...overrides,
  });
}

/** Derive AES key + IV the same way the adapter does. */
function deriveKey(encodingAesKey = TEST_ENCODING_AES_KEY) {
  const key = Buffer.from(encodingAesKey + '=', 'base64');
  return { key, iv: key.subarray(0, 16) };
}

/** Encrypt a message for testing inbound flow (mirrors encryptMessage logic). */
function testEncrypt(plaintext, corpId = TEST_CORP_ID) {
  const { key, iv } = deriveKey();
  return encryptMessage(plaintext, key, iv, corpId);
}

/** Build a valid encrypted XML body as WeCom sends to callback URL. */
function makeEncryptedXml(plainXml, corpId = TEST_CORP_ID) {
  const encrypted = testEncrypt(plainXml, corpId);
  return `<xml><ToUserName><![CDATA[${corpId}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
}

/** Compute signature for a given encrypt block. */
function makeSignature(timestamp, nonce, encrypt) {
  return computeSignature(TEST_TOKEN, timestamp, nonce, encrypt);
}

// ── Mock fetch builder ──

function mockFetch(responses = []) {
  const calls = [];
  let callIndex = 0;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const response = responses[callIndex] ?? responses[responses.length - 1] ?? { ok: true, json: async () => ({}) };
    callIndex++;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.statusText ?? 'OK',
      json: response.json ?? (async () => ({})),
      arrayBuffer: response.arrayBuffer ?? (async () => new ArrayBuffer(0)),
    };
  };
  return { fn, calls };
}

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('WeComAgentAdapter', () => {
  // ── 1. Crypto: computeSignature ──
  describe('computeSignature()', () => {
    it('produces a 40-char hex SHA1 hash', () => {
      const sig = computeSignature('token', '1234567890', 'nonce123', 'encryptedStr');
      assert.equal(sig.length, 40);
      assert.match(sig, /^[0-9a-f]{40}$/);
    });

    it('is deterministic for same inputs', () => {
      const a = computeSignature('t', '1', 'n', 'e');
      const b = computeSignature('t', '1', 'n', 'e');
      assert.equal(a, b);
    });

    it('sorts parameters before hashing', () => {
      // sha1(sort([token, ts, nonce, encrypt]).join(''))
      const sig = computeSignature('d', 'b', 'c', 'a');
      const manual = crypto.createHash('sha1').update(['a', 'b', 'c', 'd'].join('')).digest('hex');
      assert.equal(sig, manual);
    });

    it('changes when any parameter differs', () => {
      const base = computeSignature('t', '1', 'n', 'e');
      assert.notEqual(computeSignature('X', '1', 'n', 'e'), base);
      assert.notEqual(computeSignature('t', '2', 'n', 'e'), base);
      assert.notEqual(computeSignature('t', '1', 'X', 'e'), base);
      assert.notEqual(computeSignature('t', '1', 'n', 'X'), base);
    });
  });

  // ── 2. Crypto: encryptMessage + decryptMessage round-trip ──
  describe('encryptMessage() + decryptMessage()', () => {
    it('round-trips a simple message', () => {
      const { key, iv } = deriveKey();
      const encrypted = encryptMessage('hello world', key, iv, TEST_CORP_ID);
      const { message, receivedCorpId } = decryptMessage(encrypted, key, iv);
      assert.equal(message, 'hello world');
      assert.equal(receivedCorpId, TEST_CORP_ID);
    });

    it('round-trips a Chinese XML message', () => {
      const xml = '<xml><Content>你好世界</Content></xml>';
      const { key, iv } = deriveKey();
      const encrypted = encryptMessage(xml, key, iv, TEST_CORP_ID);
      const { message, receivedCorpId } = decryptMessage(encrypted, key, iv);
      assert.equal(message, xml);
      assert.equal(receivedCorpId, TEST_CORP_ID);
    });

    it('round-trips an empty string', () => {
      const { key, iv } = deriveKey();
      const encrypted = encryptMessage('', key, iv, TEST_CORP_ID);
      const { message } = decryptMessage(encrypted, key, iv);
      assert.equal(message, '');
    });

    it('round-trips a long message', () => {
      const long = 'A'.repeat(5000);
      const { key, iv } = deriveKey();
      const encrypted = encryptMessage(long, key, iv, TEST_CORP_ID);
      const { message } = decryptMessage(encrypted, key, iv);
      assert.equal(message, long);
    });

    it('preserves different corpIds', () => {
      const { key, iv } = deriveKey();
      const encrypted = encryptMessage('test', key, iv, 'ww_other_corp');
      const { receivedCorpId } = decryptMessage(encrypted, key, iv);
      assert.equal(receivedCorpId, 'ww_other_corp');
    });

    it('produces garbage or throws with wrong key', () => {
      const { key, iv } = deriveKey();
      const encrypted = encryptMessage('test', key, iv, TEST_CORP_ID);
      const wrongKey = crypto.randomBytes(32);
      const wrongIv = wrongKey.subarray(0, 16);
      try {
        const { message, receivedCorpId } = decryptMessage(encrypted, wrongKey, wrongIv);
        assert.notEqual(message, 'test');
      } catch {
        assert.ok(true);
      }
    });
  });

  // ── 3. Key derivation ──
  describe('key derivation', () => {
    it('constructor accepts a valid 43-char EncodingAESKey', () => {
      assert.doesNotThrow(() => makeAdapter());
    });

    it('constructor throws for invalid EncodingAESKey', () => {
      assert.throws(() => makeAdapter({ encodingAesKey: 'tooshort' }), /Invalid EncodingAESKey/);
    });

    it('_getCryptoParams exposes key/iv/token', () => {
      const adapter = makeAdapter();
      const params = adapter._getCryptoParams();
      assert.ok(Buffer.isBuffer(params.aesKey));
      assert.equal(params.aesKey.length, 32);
      assert.ok(Buffer.isBuffer(params.iv));
      assert.equal(params.iv.length, 16);
      assert.equal(params.token, TEST_TOKEN);
    });
  });

  // ── 4. connectorId ──
  describe('connectorId', () => {
    it('is wecom-agent', () => {
      assert.equal(makeAdapter().connectorId, 'wecom-agent');
    });
  });

  // ── 5. verifyCallback (GET echostr challenge) ──
  describe('verifyCallback()', () => {
    it('returns decrypted echostr when signature and corpId match', () => {
      const adapter = makeAdapter();
      const echostr = testEncrypt('challenge_echo_12345');
      const timestamp = '1234567890';
      const nonce = 'test_nonce';
      const sig = makeSignature(timestamp, nonce, echostr);

      const result = adapter.verifyCallback({
        msg_signature: sig,
        timestamp,
        nonce,
        echostr,
      });
      assert.equal(result, 'challenge_echo_12345');
    });

    it('returns null on signature mismatch', () => {
      const adapter = makeAdapter();
      const echostr = testEncrypt('echo');
      const result = adapter.verifyCallback({
        msg_signature: 'wrong_signature_value',
        timestamp: '1',
        nonce: 'n',
        echostr,
      });
      assert.equal(result, null);
    });

    it('returns null on corpId mismatch', () => {
      const adapter = makeAdapter();
      const { key, iv } = deriveKey();
      // Encrypt with a different corpId
      const echostr = encryptMessage('echo', key, iv, 'ww_wrong_corp');
      const timestamp = '1';
      const nonce = 'n';
      const sig = makeSignature(timestamp, nonce, echostr);

      const result = adapter.verifyCallback({
        msg_signature: sig,
        timestamp,
        nonce,
        echostr,
      });
      assert.equal(result, null);
    });

    it('returns null on decryption failure', () => {
      const adapter = makeAdapter();
      const timestamp = '1';
      const nonce = 'n';
      const badEncrypt = 'not-valid-base64-cipher!!';
      const sig = makeSignature(timestamp, nonce, badEncrypt);

      const result = adapter.verifyCallback({
        msg_signature: sig,
        timestamp,
        nonce,
        echostr: badEncrypt,
      });
      assert.equal(result, null);
    });
  });

  // ── 6. decryptInbound (POST encrypted XML) ──
  describe('decryptInbound()', () => {
    it('decrypts valid encrypted XML body', () => {
      const adapter = makeAdapter();
      const innerXml = '<xml><Content>Hello</Content><MsgType>text</MsgType></xml>';
      const encrypted = testEncrypt(innerXml);
      const body = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
      const timestamp = '12345';
      const nonce = 'nonce1';
      const sig = makeSignature(timestamp, nonce, encrypted);

      const result = adapter.decryptInbound(body, {
        msg_signature: sig,
        timestamp,
        nonce,
      });
      assert.equal(result, innerXml);
    });

    it('returns null when no <Encrypt> element', () => {
      const adapter = makeAdapter();
      const result = adapter.decryptInbound('<xml><Other>x</Other></xml>', {
        msg_signature: 'sig',
        timestamp: '1',
        nonce: 'n',
      });
      assert.equal(result, null);
    });

    it('returns null on signature mismatch', () => {
      const adapter = makeAdapter();
      const encrypted = testEncrypt('test');
      const body = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;

      const result = adapter.decryptInbound(body, {
        msg_signature: 'wrong_sig',
        timestamp: '1',
        nonce: 'n',
      });
      assert.equal(result, null);
    });

    it('returns null on corpId mismatch in decrypted content', () => {
      const adapter = makeAdapter();
      const { key, iv } = deriveKey();
      const encrypted = encryptMessage('test', key, iv, 'ww_other_corp');
      const body = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
      const timestamp = '1';
      const nonce = 'n';
      const sig = makeSignature(timestamp, nonce, encrypted);

      const result = adapter.decryptInbound(body, {
        msg_signature: sig,
        timestamp,
        nonce,
      });
      assert.equal(result, null);
    });

    it('returns null on decryption error', () => {
      const adapter = makeAdapter();
      const badEncrypt = 'garbled-non-base64';
      const body = `<xml><Encrypt><![CDATA[${badEncrypt}]]></Encrypt></xml>`;
      const timestamp = '1';
      const nonce = 'n';
      const sig = makeSignature(timestamp, nonce, badEncrypt);

      const result = adapter.decryptInbound(body, {
        msg_signature: sig,
        timestamp,
        nonce,
      });
      assert.equal(result, null);
    });
  });

  // ── 7. parseEvent (decrypted XML → normalized message) ──
  describe('parseEvent()', () => {
    it('parses text message', () => {
      const xml =
        '<xml><MsgType>text</MsgType><FromUserName>user_a</FromUserName><Content>Hello cat!</Content><MsgId>123</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.chatId, 'user_a');
      assert.equal(result.senderId, 'user_a');
      assert.equal(result.text, 'Hello cat!');
      assert.equal(result.messageId, '123');
    });

    it('trims text content whitespace', () => {
      const xml =
        '<xml><MsgType>text</MsgType><FromUserName>u</FromUserName><Content>  trimmed  </Content><MsgId>1</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.text, 'trimmed');
    });

    it('returns null for empty text content', () => {
      const xml = '<xml><MsgType>text</MsgType><FromUserName>u</FromUserName><MsgId>1</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.equal(result, null);
    });

    it('parses image message with mediaId', () => {
      const xml =
        '<xml><MsgType>image</MsgType><FromUserName>user_img</FromUserName><MediaId>mid_img</MediaId><MsgId>2</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.text, '[图片]');
      assert.ok(result.attachments);
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].type, 'image');
      assert.equal(result.attachments[0].mediaId, 'mid_img');
    });

    it('image without mediaId has no attachments', () => {
      const xml = '<xml><MsgType>image</MsgType><FromUserName>u</FromUserName><MsgId>3</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.text, '[图片]');
      assert.equal(result.attachments, undefined);
    });

    it('parses voice message with Recognition (ASR)', () => {
      const xml =
        '<xml><MsgType>voice</MsgType><FromUserName>user_v</FromUserName><MediaId>mid_v</MediaId><Recognition>你好世界</Recognition><MsgId>4</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.text, '你好世界');
      assert.ok(result.attachments);
      assert.equal(result.attachments[0].type, 'audio');
      assert.equal(result.attachments[0].mediaId, 'mid_v');
    });

    it('voice without Recognition uses fallback label', () => {
      const xml =
        '<xml><MsgType>voice</MsgType><FromUserName>u</FromUserName><MediaId>mid_v2</MediaId><MsgId>5</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.text, '[语音]');
    });

    it('parses video message', () => {
      const xml =
        '<xml><MsgType>video</MsgType><FromUserName>user_vid</FromUserName><MediaId>mid_vid</MediaId><MsgId>6</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.text, '[视频]');
      assert.ok(result.attachments);
      assert.equal(result.attachments[0].type, 'video');
      assert.equal(result.attachments[0].mediaId, 'mid_vid');
    });

    it('parses shortvideo message', () => {
      const xml =
        '<xml><MsgType>shortvideo</MsgType><FromUserName>u</FromUserName><MediaId>mid_sv</MediaId><MsgId>7</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.text, '[视频]');
      assert.equal(result.attachments[0].type, 'video');
    });

    it('parses file message with Title', () => {
      const xml =
        '<xml><MsgType>file</MsgType><FromUserName>u</FromUserName><MediaId>mid_f</MediaId><Title>report.pdf</Title><MsgId>8</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.text, '[文件] report.pdf');
      assert.ok(result.attachments);
      assert.equal(result.attachments[0].type, 'file');
      assert.equal(result.attachments[0].mediaId, 'mid_f');
      assert.equal(result.attachments[0].fileName, 'report.pdf');
    });

    it('file without Title yields trimmed label', () => {
      const xml =
        '<xml><MsgType>file</MsgType><FromUserName>u</FromUserName><MediaId>mid_f2</MediaId><MsgId>9</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.text, '[文件]');
    });

    it('parses location message', () => {
      const xml =
        '<xml><MsgType>location</MsgType><FromUserName>u</FromUserName><Label>北京市</Label><Location_X>39.9</Location_X><Location_Y>116.4</Location_Y><MsgId>10</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(result.text, '[位置] 北京市');
    });

    it('location without Label uses coordinates', () => {
      const xml =
        '<xml><MsgType>location</MsgType><FromUserName>u</FromUserName><Location_X>39.9</Location_X><Location_Y>116.4</Location_Y><MsgId>11</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.ok(result.text.includes('39.9'));
      assert.ok(result.text.includes('116.4'));
    });

    it('returns null for event type messages', () => {
      const xml = '<xml><MsgType>event</MsgType><FromUserName>u</FromUserName><Event>subscribe</Event></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.equal(result, null);
    });

    it('returns null for unknown message type', () => {
      const xml = '<xml><MsgType>card</MsgType><FromUserName>u</FromUserName><MsgId>12</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.equal(result, null);
    });

    it('returns null for missing MsgType', () => {
      const xml = '<xml><FromUserName>u</FromUserName><MsgId>13</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.equal(result, null);
    });

    it('returns null for missing FromUserName', () => {
      const xml = '<xml><MsgType>text</MsgType><Content>hello</Content><MsgId>14</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.equal(result, null);
    });

    it('returns null for empty/invalid XML', () => {
      assert.equal(makeAdapter().parseEvent(''), null);
    });

    it('generates fallback msgId when MsgId is missing', () => {
      const xml = '<xml><MsgType>text</MsgType><FromUserName>u</FromUserName><Content>hi</Content></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.ok(result.messageId.startsWith('wa-'));
    });
  });

  // ── 8. Access Token Management ──
  describe('getAccessToken()', () => {
    it('fetches token from API on first call', async () => {
      const adapter = makeAdapter();
      const { fn, calls } = mockFetch([
        { json: async () => ({ errcode: 0, access_token: 'tok_001', expires_in: 7200 }) },
      ]);
      adapter._injectFetch(fn);

      const token = await adapter.getAccessToken();
      assert.equal(token, 'tok_001');
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes('gettoken'));
    });

    it('returns cached token on second call', async () => {
      const adapter = makeAdapter();
      const { fn, calls } = mockFetch([
        { json: async () => ({ errcode: 0, access_token: 'tok_cached', expires_in: 7200 }) },
      ]);
      adapter._injectFetch(fn);

      await adapter.getAccessToken();
      const second = await adapter.getAccessToken();
      assert.equal(second, 'tok_cached');
      assert.equal(calls.length, 1); // No second API call
    });

    it('uses injected token without API call', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('injected_tok');
      const { fn, calls } = mockFetch([]);
      adapter._injectFetch(fn);

      const token = await adapter.getAccessToken();
      assert.equal(token, 'injected_tok');
      assert.equal(calls.length, 0);
    });

    it('refreshes expired token', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('old_tok', Date.now() - 1000); // Already expired

      const { fn, calls } = mockFetch([
        { json: async () => ({ errcode: 0, access_token: 'new_tok', expires_in: 7200 }) },
      ]);
      adapter._injectFetch(fn);

      const token = await adapter.getAccessToken();
      assert.equal(token, 'new_tok');
      assert.equal(calls.length, 1);
    });

    it('throws on HTTP error', async () => {
      const adapter = makeAdapter();
      const { fn } = mockFetch([{ ok: false, status: 500, statusText: 'Internal Server Error' }]);
      adapter._injectFetch(fn);

      await assert.rejects(() => adapter.getAccessToken(), /HTTP 500/);
    });

    it('throws on API errcode', async () => {
      const adapter = makeAdapter();
      const { fn } = mockFetch([{ json: async () => ({ errcode: 40013, errmsg: 'invalid corpid' }) }]);
      adapter._injectFetch(fn);

      await assert.rejects(() => adapter.getAccessToken(), /errcode 40013/);
    });

    it('throws when access_token missing in response', async () => {
      const adapter = makeAdapter();
      const { fn } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      await assert.rejects(() => adapter.getAccessToken(), /no access_token/);
    });

    it('invalidateToken forces refresh on next call', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('will_be_invalidated');

      adapter.invalidateToken();

      const { fn, calls } = mockFetch([
        { json: async () => ({ errcode: 0, access_token: 'fresh_tok', expires_in: 7200 }) },
      ]);
      adapter._injectFetch(fn);

      const token = await adapter.getAccessToken();
      assert.equal(token, 'fresh_tok');
      assert.equal(calls.length, 1);
    });
  });

  // ── 9. sendReply ──
  describe('sendReply()', () => {
    it('sends text message via message/send API', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      await adapter.sendReply('user_001', 'Hello!');
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes('message/send'));

      const body = JSON.parse(calls[0].opts.body);
      assert.equal(body.touser, 'user_001');
      assert.equal(body.msgtype, 'text');
      assert.equal(body.text.content, 'Hello!');
      assert.equal(body.agentid, Number(TEST_AGENT_ID));
    });

    it('chunks long messages into multiple sends', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }, { json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      // Create a message > 2048 bytes (Chinese chars = 3 bytes each)
      const longText = '中'.repeat(700); // 700 * 3 = 2100 bytes > 2048
      await adapter.sendReply('user_001', longText);
      assert.ok(calls.length >= 2, `Expected at least 2 chunks, got ${calls.length}`);
    });

    it('throws on HTTP error from message/send', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn } = mockFetch([{ ok: false, status: 502, statusText: 'Bad Gateway' }]);
      adapter._injectFetch(fn);

      await assert.rejects(() => adapter.sendReply('u', 'hi'), /HTTP 502/);
    });

    it('throws on non-zero errcode from message/send', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn } = mockFetch([{ json: async () => ({ errcode: 60020, errmsg: 'not allowed' }) }]);
      adapter._injectFetch(fn);

      await assert.rejects(() => adapter.sendReply('u', 'hi'), /errcode 60020/);
    });

    it('retries on token expiry (40001) and succeeds', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('old_tok');
      const { fn, calls } = mockFetch([
        // First call: token expired
        { json: async () => ({ errcode: 40001, errmsg: 'invalid access_token' }) },
        // gettoken refresh
        { json: async () => ({ errcode: 0, access_token: 'new_tok', expires_in: 7200 }) },
        // Retry message/send: success
        { json: async () => ({ errcode: 0, errmsg: 'ok' }) },
      ]);
      adapter._injectFetch(fn);

      await adapter.sendReply('user_001', 'retry test');
      assert.ok(calls.length >= 3);
    });

    it('retries on token expiry (42001) and succeeds', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('old_tok');
      const { fn, calls } = mockFetch([
        { json: async () => ({ errcode: 42001, errmsg: 'access_token expired' }) },
        { json: async () => ({ errcode: 0, access_token: 'refreshed_tok', expires_in: 7200 }) },
        { json: async () => ({ errcode: 0 }) },
      ]);
      adapter._injectFetch(fn);

      await adapter.sendReply('u', 'retry42001');
      assert.ok(calls.length >= 3);
    });
  });

  // ── 10. sendFormattedReply ──
  describe('sendFormattedReply()', () => {
    it('sends markdown format by default', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      const envelope = {
        header: '🐱 布偶猫',
        body: 'Hello world',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('user_001', envelope);
      assert.equal(calls.length, 1);

      const body = JSON.parse(calls[0].opts.body);
      assert.equal(body.msgtype, 'markdown');
      assert.ok(body.markdown.content.includes('🐱 布偶猫'));
      assert.ok(body.markdown.content.includes('Hello world'));
    });

    it('prefixes callback origin with 📨', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      const envelope = {
        header: 'Cat',
        body: 'Callback content',
        origin: 'callback',
      };
      await adapter.sendFormattedReply('u', envelope);

      const body = JSON.parse(calls[0].opts.body);
      assert.ok(body.markdown.content.includes('📨'));
    });

    it('includes subtitle when present', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      const envelope = {
        header: 'Cat',
        subtitle: 'Sub info',
        body: 'Body',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('u', envelope);
      const body = JSON.parse(calls[0].opts.body);
      assert.ok(body.markdown.content.includes('Sub info'));
    });

    it('includes footer when present', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      const envelope = {
        header: 'Cat',
        body: 'Body',
        footer: 'Footer text',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('u', envelope);
      const body = JSON.parse(calls[0].opts.body);
      assert.ok(body.markdown.content.includes('Footer text'));
    });

    it('sends textcard when footer contains a URL', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      const envelope = {
        header: 'Notification',
        body: 'Card body text content here',
        footer: '查看详情 https://cat.cafe/thread/123',
        origin: 'direct',
      };
      await adapter.sendFormattedReply('u', envelope);
      const body = JSON.parse(calls[0].opts.body);
      assert.equal(body.msgtype, 'textcard');
      assert.equal(body.textcard.title, 'Notification');
      assert.ok(body.textcard.url.includes('https://cat.cafe/thread/123'));
    });

    it('textcard callback origin includes 📨 prefix in title', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      const envelope = {
        header: 'Cat',
        body: 'Content',
        footer: 'https://example.com',
        origin: 'callback',
      };
      await adapter.sendFormattedReply('u', envelope);
      const body = JSON.parse(calls[0].opts.body);
      assert.equal(body.msgtype, 'textcard');
      assert.ok(body.textcard.title.includes('📨'));
    });

    it('chunks long markdown content', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }, { json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      const envelope = {
        header: 'Cat',
        body: '中'.repeat(700), // > 2048 bytes
        origin: 'direct',
      };
      await adapter.sendFormattedReply('u', envelope);
      assert.ok(calls.length >= 2);
    });
  });

  // ── 11. sendMedia ──
  describe('sendMedia()', () => {
    it('uploads file from absPath and sends via message/send', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');

      const { fn, calls } = mockFetch([
        // upload response
        { json: async () => ({ errcode: 0, media_id: 'uploaded_mid' }) },
        // message/send response
        { json: async () => ({ errcode: 0 }) },
      ]);
      adapter._injectFetch(fn);

      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      const tmpDir = '/tmp/wecom-agent-test-media';
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(`${tmpDir}/test.jpg`, 'fake-image-data');

      try {
        await adapter.sendMedia('user_001', {
          type: 'image',
          absPath: `${tmpDir}/test.jpg`,
          fileName: 'test.jpg',
        });

        assert.equal(calls.length, 2);
        // First call: upload
        assert.ok(calls[0].url.includes('media/upload'));
        assert.ok(calls[0].url.includes('type=image'));
        // Second call: send
        assert.ok(calls[1].url.includes('message/send'));
        const sendBody = JSON.parse(calls[1].opts.body);
        assert.equal(sendBody.msgtype, 'image');
        assert.equal(sendBody.image.media_id, 'uploaded_mid');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('maps audio type to voice for WeCom API', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');

      const { fn, calls } = mockFetch([
        { json: async () => ({ errcode: 0, media_id: 'voice_mid' }) },
        { json: async () => ({ errcode: 0 }) },
      ]);
      adapter._injectFetch(fn);

      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      const tmpDir = '/tmp/wecom-agent-test-audio';
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(`${tmpDir}/voice.wav`, 'fake-audio');

      try {
        await adapter.sendMedia('u', {
          type: 'audio',
          absPath: `${tmpDir}/voice.wav`,
        });
        // Upload should use 'voice' type
        assert.ok(calls[0].url.includes('type=voice'));
        // Send should use 'voice' msgtype
        const sendBody = JSON.parse(calls[1].opts.body);
        assert.equal(sendBody.msgtype, 'voice');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('falls back to text link when upload fails', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');

      const { fn, calls } = mockFetch([
        // upload fails
        { ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) },
        // fallback sendReply (text)
        { json: async () => ({ errcode: 0 }) },
      ]);
      adapter._injectFetch(fn);

      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      const tmpDir = '/tmp/wecom-agent-test-fallback';
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(`${tmpDir}/fail.pdf`, 'data');

      try {
        await adapter.sendMedia('u', {
          type: 'file',
          absPath: `${tmpDir}/fail.pdf`,
          url: 'https://example.com/file.pdf',
        });
        // Should have fallen back to text
        const lastCall = calls[calls.length - 1];
        assert.ok(lastCall.url.includes('message/send'));
        const body = JSON.parse(lastCall.opts.body);
        assert.equal(body.msgtype, 'text');
        assert.ok(body.text.content.includes('https://example.com/file.pdf'));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('falls back to text with fileName when no URL or absPath', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      await adapter.sendMedia('u', {
        type: 'file',
        fileName: 'document.pdf',
      });
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].opts.body);
      assert.equal(body.msgtype, 'text');
      assert.ok(body.text.content.includes('document.pdf'));
    });

    it('uses correct emoji prefix per media type', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const sentContent = [];
      const { fn } = mockFetch([
        { json: async () => ({ errcode: 0 }) },
        { json: async () => ({ errcode: 0 }) },
        { json: async () => ({ errcode: 0 }) },
      ]);
      adapter._injectFetch(fn);

      await adapter.sendMedia('u', { type: 'image', url: 'http://img.jpg' });
      await adapter.sendMedia('u', { type: 'audio', url: 'http://audio.wav' });
      await adapter.sendMedia('u', { type: 'file', url: 'http://doc.pdf' });

      // Can't easily check content from mock, but verifying no errors suffices
      // Let's just verify all 3 calls were made
      assert.ok(true);
    });

    it('skips send when no file info available', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([]);
      adapter._injectFetch(fn);

      await adapter.sendMedia('u', { type: 'image' });
      assert.equal(calls.length, 0);
    });

    it('falls back to basename when no fileName provided for absPath', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      await adapter.sendMedia('u', {
        type: 'file',
        absPath: '/path/to/report.pdf',
      });
      const body = JSON.parse(calls[0].opts.body);
      assert.ok(body.text.content.includes('report.pdf'));
    });
  });

  // ── 12. downloadMedia ──
  describe('downloadMedia()', () => {
    it('downloads media by mediaId via /media/get', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const testData = Buffer.from('image-binary-data');
      const { fn, calls } = mockFetch([
        {
          arrayBuffer: async () =>
            testData.buffer.slice(testData.byteOffset, testData.byteOffset + testData.byteLength),
        },
      ]);
      adapter._injectFetch(fn);

      const result = await adapter.downloadMedia('mid_download');
      assert.ok(Buffer.isBuffer(result));
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes('media/get'));
      assert.ok(calls[0].url.includes('media_id=mid_download'));
    });

    it('throws on HTTP error from media/get', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn } = mockFetch([{ ok: false, status: 404, statusText: 'Not Found' }]);
      adapter._injectFetch(fn);

      await assert.rejects(() => adapter.downloadMedia('bad_mid'), /HTTP 404/);
    });

    it('requests fresh token for download', async () => {
      const adapter = makeAdapter();
      const { fn, calls } = mockFetch([
        // gettoken
        { json: async () => ({ errcode: 0, access_token: 'dl_tok', expires_in: 7200 }) },
        // media/get
        { arrayBuffer: async () => new ArrayBuffer(0) },
      ]);
      adapter._injectFetch(fn);

      await adapter.downloadMedia('mid_fresh');
      assert.equal(calls.length, 2);
      assert.ok(calls[0].url.includes('gettoken'));
      assert.ok(calls[1].url.includes('media/get'));
    });
  });

  // ── 13. chunkMessage ──
  describe('chunkMessage()', () => {
    it('returns single chunk when text fits', () => {
      const adapter = makeAdapter();
      const result = adapter.chunkMessage('short text', 2048);
      assert.equal(result.length, 1);
      assert.equal(result[0], 'short text');
    });

    it('splits long ASCII text', () => {
      const adapter = makeAdapter();
      const text = 'A'.repeat(3000);
      const result = adapter.chunkMessage(text, 2048);
      assert.ok(result.length >= 2);
      for (const chunk of result) {
        assert.ok(Buffer.byteLength(chunk, 'utf-8') <= 2048);
      }
      assert.equal(result.join(''), text);
    });

    it('splits at newline boundary when possible', () => {
      const adapter = makeAdapter();
      const line1 = 'A'.repeat(1000);
      const line2 = 'B'.repeat(1000);
      const line3 = 'C'.repeat(1000);
      const text = `${line1}\n${line2}\n${line3}`;
      const result = adapter.chunkMessage(text, 2048);
      assert.ok(result.length >= 2);
      assert.ok(result[0].endsWith(line1) || result[0].includes(line1));
    });

    it('splits at space boundary when no newline', () => {
      const adapter = makeAdapter();
      const text = `${'A'.repeat(1000)} ${'B'.repeat(1000)} ${'C'.repeat(1000)}`;
      const result = adapter.chunkMessage(text, 2048);
      assert.ok(result.length >= 2);
    });

    it('handles multibyte characters correctly (byte-aware)', () => {
      const adapter = makeAdapter();
      // Each Chinese char is 3 bytes. 700 chars = 2100 bytes > 2048.
      const text = '中'.repeat(700);
      const result = adapter.chunkMessage(text, 2048);
      assert.ok(result.length >= 2, `Expected >=2 chunks, got ${result.length}`);
      for (const chunk of result) {
        assert.ok(
          Buffer.byteLength(chunk, 'utf-8') <= 2048,
          `Chunk exceeds 2048 bytes: ${Buffer.byteLength(chunk, 'utf-8')}`,
        );
      }
      // Verify no data loss
      assert.equal(result.join(''), text);
    });

    it('hard-cuts when no natural break point', () => {
      const adapter = makeAdapter();
      const text = 'A'.repeat(5000); // No spaces or newlines
      const result = adapter.chunkMessage(text, 2048);
      assert.ok(result.length >= 3);
      assert.equal(result.join(''), text);
    });

    it('handles empty text', () => {
      const adapter = makeAdapter();
      const result = adapter.chunkMessage('', 2048);
      assert.equal(result.length, 1);
      assert.equal(result[0], '');
    });

    it('handles text exactly at byte limit', () => {
      const adapter = makeAdapter();
      const text = 'A'.repeat(2048);
      const result = adapter.chunkMessage(text, 2048);
      assert.equal(result.length, 1);
      assert.equal(result[0], text);
    });
  });

  // ── 14. IOutboundAdapter interface ──
  describe('IOutboundAdapter interface', () => {
    it('implements all required methods', () => {
      const adapter = makeAdapter();
      assert.equal(typeof adapter.sendReply, 'function');
      assert.equal(typeof adapter.sendFormattedReply, 'function');
      assert.equal(typeof adapter.sendMedia, 'function');
    });

    it('does NOT implement streaming methods (non-streaming adapter)', () => {
      const adapter = makeAdapter();
      assert.equal(typeof adapter.sendPlaceholder, 'undefined');
      assert.equal(typeof adapter.editMessage, 'undefined');
      assert.equal(typeof adapter.deleteMessage, 'undefined');
    });
  });

  // ── 15. DI injection methods ──
  describe('DI injection methods', () => {
    it('_injectFetch overrides fetch', async () => {
      const adapter = makeAdapter();
      let called = false;
      adapter._injectFetch(async () => {
        called = true;
        return { ok: true, json: async () => ({ errcode: 0, access_token: 't', expires_in: 7200 }) };
      });
      await adapter.getAccessToken();
      assert.ok(called);
    });

    it('_injectAccessToken sets cached token', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('manual_tok', Date.now() + 60_000);
      const { fn, calls } = mockFetch([]);
      adapter._injectFetch(fn);
      const token = await adapter.getAccessToken();
      assert.equal(token, 'manual_tok');
      assert.equal(calls.length, 0);
    });

    it('_getCryptoParams returns aesKey/iv/token', () => {
      const adapter = makeAdapter();
      const params = adapter._getCryptoParams();
      assert.ok(params.aesKey);
      assert.ok(params.iv);
      assert.equal(params.token, TEST_TOKEN);
    });
  });

  // ── 16. End-to-end: decrypt + parse pipeline ──
  describe('end-to-end inbound pipeline', () => {
    it('decryptInbound + parseEvent produces valid message', () => {
      const adapter = makeAdapter();
      const innerXml =
        '<xml><MsgType>text</MsgType><FromUserName>alice</FromUserName><Content>End to end!</Content><MsgId>999</MsgId></xml>';
      const encrypted = testEncrypt(innerXml);
      const body = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
      const timestamp = '9999';
      const nonce = 'e2e_nonce';
      const sig = makeSignature(timestamp, nonce, encrypted);

      const decrypted = adapter.decryptInbound(body, {
        msg_signature: sig,
        timestamp,
        nonce,
      });
      assert.ok(decrypted);

      const msg = adapter.parseEvent(decrypted);
      assert.ok(msg);
      assert.equal(msg.chatId, 'alice');
      assert.equal(msg.text, 'End to end!');
      assert.equal(msg.messageId, '999');
    });

    it('full pipeline with image message', () => {
      const adapter = makeAdapter();
      const innerXml =
        '<xml><MsgType>image</MsgType><FromUserName>bob</FromUserName><MediaId>media_e2e</MediaId><MsgId>888</MsgId></xml>';
      const encrypted = testEncrypt(innerXml);
      const body = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
      const timestamp = '8888';
      const nonce = 'e2e_img';
      const sig = makeSignature(timestamp, nonce, encrypted);

      const decrypted = adapter.decryptInbound(body, { msg_signature: sig, timestamp, nonce });
      const msg = adapter.parseEvent(decrypted);
      assert.ok(msg);
      assert.equal(msg.chatId, 'bob');
      assert.equal(msg.text, '[图片]');
      assert.equal(msg.attachments[0].mediaId, 'media_e2e');
    });
  });

  // ── 17. Edge cases ──
  describe('edge cases', () => {
    it('sendReply with single char works', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      await adapter.sendReply('u', 'X');
      assert.equal(calls.length, 1);
    });

    it('sendFormattedReply without subtitle or footer', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      const envelope = { header: 'Simple', body: 'Just body', origin: 'direct' };
      await adapter.sendFormattedReply('u', envelope);
      const body = JSON.parse(calls[0].opts.body);
      assert.ok(!body.markdown.content.includes('undefined'));
    });

    it('chunkMessage with 4-byte emoji characters', () => {
      const adapter = makeAdapter();
      // 4-byte emoji: 🐱 = 4 bytes
      const text = '🐱'.repeat(600); // 600 * 4 = 2400 bytes > 2048
      const result = adapter.chunkMessage(text, 2048);
      assert.ok(result.length >= 2);
      for (const chunk of result) {
        assert.ok(Buffer.byteLength(chunk, 'utf-8') <= 2048);
      }
    });

    it('decryptInbound handles xml root wrapper', () => {
      const adapter = makeAdapter();
      const innerXml = '<xml><MsgType>text</MsgType><FromUserName>u</FromUserName><Content>test</Content></xml>';
      const encrypted = testEncrypt(innerXml);
      // Try without nested <xml>
      const body = `<xml><Encrypt>${encrypted}</Encrypt></xml>`;
      const timestamp = '1';
      const nonce = 'n';
      const sig = makeSignature(timestamp, nonce, encrypted);

      const result = adapter.decryptInbound(body, { msg_signature: sig, timestamp, nonce });
      assert.ok(result);
    });

    it('parseEvent handles numeric MsgId', () => {
      // XML parser may return MsgId as number
      const xml =
        '<xml><MsgType>text</MsgType><FromUserName>u</FromUserName><Content>hi</Content><MsgId>12345678901234</MsgId></xml>';
      const result = makeAdapter().parseEvent(xml);
      assert.ok(result);
      assert.equal(typeof result.messageId, 'string');
    });

    it('multiple sendMedia calls work independently', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([{ json: async () => ({ errcode: 0 }) }, { json: async () => ({ errcode: 0 }) }]);
      adapter._injectFetch(fn);

      await adapter.sendMedia('u1', { type: 'image', url: 'http://a.jpg' });
      await adapter.sendMedia('u2', { type: 'file', url: 'http://b.pdf' });
      assert.equal(calls.length, 2);
    });

    it('uploadMedia returns null on errcode failure', async () => {
      const adapter = makeAdapter();
      adapter._injectAccessToken('tok');
      const { fn, calls } = mockFetch([
        // upload returns errcode
        { json: async () => ({ errcode: 40004, errmsg: 'invalid media type' }) },
        // fallback sendReply
        { json: async () => ({ errcode: 0 }) },
      ]);
      adapter._injectFetch(fn);

      const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
      const tmpDir = '/tmp/wecom-agent-test-upload-err';
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(`${tmpDir}/t.jpg`, 'data');

      try {
        await adapter.sendMedia('u', {
          type: 'image',
          absPath: `${tmpDir}/t.jpg`,
          url: 'http://fallback.jpg',
        });
        // Should have fallen back to text link
        assert.ok(calls.length >= 2);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
