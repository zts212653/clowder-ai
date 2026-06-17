// F212 Phase A — Task 1: Sanitizer fuzz tests (AC-A2 + AC-A3)
//
// AC-A2: ANSI/OSC, NFKC, paths, JWT, PEM, URL query, cookies, 5 provider tokens, high-entropy
// AC-A3: 先 sanitize 再截断 — token 中间截尾不能绕过黑名单

import assert from 'node:assert';
import test from 'node:test';
import { sanitizeCliStderr } from '../dist/utils/sanitize-cli-stderr.js';

test('strips ANSI escape sequences', () => {
  const input = '\x1b[31mError\x1b[0m: thing';
  assert.strictEqual(sanitizeCliStderr(input), 'Error: thing');
});

test('strips OSC sequences (terminal title)', () => {
  const input = '\x1b]0;title\x07hello';
  assert.strictEqual(sanitizeCliStderr(input), 'hello');
});

test('NFKC normalizes fullwidth homoglyph tokens', () => {
  // U+FF53 ｓ fullwidth s — without NFKC could bypass sk- regex
  const input = 'ｓk-ABCDEFGHIJ12345abcdefgh';
  const out = sanitizeCliStderr(input);
  assert.ok(out.includes('[TOKEN_REDACTED]'), `expected redaction, got: ${out}`);
});

test('redacts HOME path to ~/', () => {
  const home = process.env.HOME || '/home/user';
  const input = `Error: ENOENT ${home}/foo/bar`;
  const out = sanitizeCliStderr(input);
  assert.ok(out.includes('~/foo/bar'), `expected ~/foo/bar, got: ${out}`);
  assert.ok(!out.includes(home), `home path leaked: ${out}`);
});

test('redacts caller-provided child HOME path to ~/', () => {
  const childHome = '/srv/agy/home';
  const input = `401 Unauthorized while reading ${childHome}/.config/agy/auth.json`;
  const out = sanitizeCliStderr(input, { additionalHomePaths: [childHome] });
  assert.ok(out.includes('~/.config/agy/auth.json'), `expected child HOME redaction, got: ${out}`);
  assert.ok(!out.includes(childHome), `child HOME path leaked: ${out}`);
});

test('redacts caller-provided child HOME path before colon-delimited errors', () => {
  const childHome = '/srv/agy/home';
  const input = `${childHome}: permission denied`;
  const out = sanitizeCliStderr(input, { additionalHomePaths: [childHome] });
  assert.strictEqual(out, '~: permission denied');
  assert.ok(!out.includes(childHome), `child HOME path leaked: ${out}`);
});

test('redacts high-entropy temp HOME path before entropy fallback', () => {
  const originalHome = process.env.HOME;
  const home = '/tmp/cat-cafe-test-home-aB3xZ9pQ7nM2vL5kR8tY4wU6';
  try {
    process.env.HOME = home;
    const input = `Error: ENOENT ${home}/foo/bar`;
    const out = sanitizeCliStderr(input);
    assert.ok(out.includes('~/foo/bar'), `expected ~/foo/bar, got: ${out}`);
    assert.ok(!out.includes(home), `home path leaked: ${out}`);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
});

test('redacts Windows C:\\Users\\... path', () => {
  const input = 'Error at C:\\Users\\maxzhong1997\\Desktop\\foo.exe';
  const out = sanitizeCliStderr(input);
  assert.ok(out.includes('~'), `expected ~, got: ${out}`);
  assert.ok(!out.includes('maxzhong1997'), `username leaked: ${out}`);
});

test('redacts JWT three-segment tokens', () => {
  const input = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  assert.ok(sanitizeCliStderr(input).includes('[JWT_REDACTED]'));
});

test('redacts PEM private key block', () => {
  const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
  const out = sanitizeCliStderr(input);
  assert.ok(out.includes('[PEM_REDACTED]'));
  assert.ok(!out.includes('MIIEpAIBAAK'));
});

test('redacts URL query string entirely', () => {
  const input = 'GET https://api.example.com/v1/foo?api_key=sk-abc123def456ghijklmnop&user=bob HTTP/1.1';
  const out = sanitizeCliStderr(input);
  assert.ok(out.includes('[QUERY_REDACTED]'), `expected QUERY_REDACTED, got: ${out}`);
  assert.ok(!out.includes('sk-abc123def456ghijklmnop'), `token leaked via query: ${out}`);
});

test('redacts URL fragment string entirely', () => {
  const input =
    'Open https://accounts.google.com/o/oauth2/auth#state=very-secret-state&access_token=ya29.AGYAccessToken';
  const out = sanitizeCliStderr(input);
  assert.ok(out.includes('[FRAGMENT_REDACTED]'), `expected FRAGMENT_REDACTED, got: ${out}`);
  assert.ok(!out.includes('very-secret-state'), `state leaked via fragment: ${out}`);
  assert.ok(!out.includes('ya29.AGYAccessToken'), `access token leaked via fragment: ${out}`);
});

test('redacts sensitive fragment-only OAuth payloads', () => {
  const input = 'callback failed with #state=very-secret-state&access_token=ya29.AGYAccessToken';
  const out = sanitizeCliStderr(input);
  assert.ok(out.includes('[FRAGMENT_REDACTED]'), `expected FRAGMENT_REDACTED, got: ${out}`);
  assert.ok(!out.includes('very-secret-state'), `state leaked via fragment-only payload: ${out}`);
  assert.ok(!out.includes('ya29.AGYAccessToken'), `access token leaked via fragment-only payload: ${out}`);
});

test('redacts cookie / set-cookie header values', () => {
  const input = 'set-cookie: session=abc123def456ghi789xyz; Path=/';
  const out = sanitizeCliStderr(input);
  assert.ok(out.includes('[COOKIE_REDACTED]'), `expected COOKIE_REDACTED, got: ${out}`);
});

test('redacts OpenAI/Anthropic sk- token', () => {
  const input = 'invalid api key sk-AbCdEfGh1234567890IjKlMnOpQr';
  assert.ok(sanitizeCliStderr(input).includes('[TOKEN_REDACTED]'));
});

test('redacts GitHub ghp_ / github_pat_ tokens', () => {
  const ghp = `ghp_${'A'.repeat(36)}`;
  const pat = `github_pat_${'A'.repeat(82)}`;
  const out1 = sanitizeCliStderr(`error: ${ghp}`);
  const out2 = sanitizeCliStderr(`error: ${pat}`);
  assert.ok(out1.includes('[TOKEN_REDACTED]'), `ghp leaked: ${out1}`);
  assert.ok(out2.includes('[TOKEN_REDACTED]'), `pat leaked: ${out2}`);
});

test('redacts npm token', () => {
  const tok = `npm_${'A'.repeat(36)}`;
  assert.ok(sanitizeCliStderr(`auth ${tok}`).includes('[TOKEN_REDACTED]'));
});

test('redacts Gemini/Google AIza key', () => {
  const tok = `AIza${'A'.repeat(35)}`;
  assert.ok(sanitizeCliStderr(`api key ${tok}`).includes('[TOKEN_REDACTED]'));
});

test('redacts generic Bearer token', () => {
  const input = 'Authorization: Bearer abc.def.ghi/jkl=';
  assert.ok(sanitizeCliStderr(input).includes('[TOKEN_REDACTED]'));
});

test('redacts lowercase/mixed-case bearer token (云端 codex P1 — RFC 7235 case-insensitive)', () => {
  const lower = 'authorization: bearer abc.def.ghi/jkl=';
  const mixed = 'AUTHORIZATION: BeArEr xyz.123.456_=';
  assert.ok(!sanitizeCliStderr(lower).includes('abc.def.ghi'), `lowercase bearer leaked: ${sanitizeCliStderr(lower)}`);
  assert.ok(!sanitizeCliStderr(mixed).includes('xyz.123.456'), `mixed-case bearer leaked: ${sanitizeCliStderr(mixed)}`);
});

test('redacts generic token=value pattern', () => {
  const input = '{"api_key": "secret-abc123def456ghijklmnop"}';
  const out = sanitizeCliStderr(input);
  assert.ok(out.includes('[TOKEN_REDACTED]'), `expected redaction, got: ${out}`);
});

test('redacts high-entropy base64 secret (≥32 chars)', () => {
  // 32 chars, high variety
  const secret = 'aB3xZ9pQ7nM2vL5kR8tY4wU6jH1fG0sD';
  const out = sanitizeCliStderr(`secret=${secret}`);
  assert.ok(out.includes('[REDACTED]') || out.includes('[TOKEN_REDACTED]'), `expected redaction, got: ${out}`);
});

test('AC-A3 critical: sanitize-then-truncate cannot bypass token via mid-truncation', () => {
  // 老 bug — truncate(.slice(-500)) 切到 token 中间 → 黑名单只看到尾部碎片
  // sanitizer 必须先扫整段，让 caller 之后 truncate
  const tok = `sk-${'X'.repeat(40)}`; // 43 chars
  const prefix = 'A'.repeat(2000);
  const input = `${prefix}${tok}${'B'.repeat(500)}`;
  const out = sanitizeCliStderr(input);
  assert.ok(!out.includes(tok), 'raw token leaked');
  assert.ok(out.includes('[TOKEN_REDACTED]'), 'expected redaction marker');
});

test('handles empty input gracefully', () => {
  assert.strictEqual(sanitizeCliStderr(''), '');
});

test('idempotent — sanitizing already-sanitized output is no-op', () => {
  const input = 'invalid api key sk-AbCdEfGh1234567890IjKlMnOpQr';
  const once = sanitizeCliStderr(input);
  const twice = sanitizeCliStderr(once);
  assert.strictEqual(once, twice, 'sanitizer should be idempotent');
});
