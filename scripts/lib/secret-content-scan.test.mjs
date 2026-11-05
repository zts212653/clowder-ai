import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactSecretContent, scanSecretContent } from './secret-content-scan.mjs';

const github = () => ['ghp', '_', 'a'.repeat(36)].join('');
const provider = () => ['sk', '-proj-', 'b'.repeat(64)].join('');

describe('plaintext secret boundary', () => {
  it('accepts task IDs and source expressions rather than treating them as bare keys', () => {
    for (const value of [
      'task-12345678-1234-1234-1234-123456789abc',
      'const apiKey = process.env.TTFUND_APIKEY;',
      'password: authenticationServicePasswordReference',
    ])
      assert.deepEqual(scanSecretContent(value), []);
  });
  it('does not treat a published variable name as an actual credential value', () => {
    assert.deepEqual(scanSecretContent("apiKey: 'CAT_CAFE_ANTHROPIC_API_KEY'"), []);
    assert.deepEqual(scanSecretContent("callbackToken: 'CAT_CAFE_CALLBACK_TOKEN_TEMPLATE'"), []);
    assert.ok(scanSecretContent(`apiKey: 'CAT_CAFE_ANTHROPIC_API_KEY'; key='${github()}'`).length);
  });
  for (const [name, wrap] of [
    ['markdown code fence', (value) => `\`\`\`sh\n${value}\n\`\`\``],
    ['JSON body', (value) => JSON.stringify({ comment: value })],
    ['URL query', (value) => `https://example.invalid/?q=${value}`],
    ['placeholder beside a real token', (value) => `EXAMPLE: ${value}`],
    ['surrounding identifier characters', (value) => `prefix_${value}_suffix`],
    ['non-UTF8 file', (value) => Buffer.concat([Buffer.from([0xff, 0]), Buffer.from(value)])],
  ]) {
    it(`blocks a credential in ${name}`, () => {
      assert.ok(scanSecretContent(wrap(github())).length > 0);
    });
  }

  it('detects provider credentials and a contextual password', () => {
    assert.ok(scanSecretContent(provider()).length > 0);
    const password = ['s4bP8kW1rN7xQ2vL9', 'cD5fG0jH6tY3zAu'].join('');
    assert.ok(scanSecretContent(`PASSWORD="${password}"`).length > 0);
  });

  it('never returns the matched value, even a prefix or suffix', () => {
    const secret = github();
    const findings = scanSecretContent(`one\n${secret}\n`);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, 'github-token');
    assert.equal(findings[0].line, 2);
    assert.equal(findings[0].column, 1);
    assert.ok(!JSON.stringify(findings).includes(secret));
    assert.ok(!JSON.stringify(findings).includes(secret.slice(-8)));
  });

  it('redacts the union when a later overlapping credential extends past the first match', () => {
    const value = ['sk', '-proj-', 'A'.repeat(1000), github()].join('');
    assert.ok(redactSecretContent(value) === '[credential redacted]', 'an overlapping match tail must not survive');
  });

  it('allows metadata, format expressions, placeholders, and ordinary object IDs', () => {
    for (const text of [
      'OPENAI_API_KEY is configured: true',
      'export const pattern = /gh[pousr]_[A-Za-z0-9]{36}/;',
      'API_KEY=YOUR_API_KEY',
      'OPENROUTER_API_KEY: OPENROUTER_API_KEY_TEMPLATE',
      `commit: ${'deadbeef'.repeat(5)}`,
      'https://example.invalid/docs?q=configuration',
      ['password: $', '{PASSWORD}'].join(''),
    ])
      assert.deepEqual(scanSecretContent(text), []);
  });

  it('fails explicitly instead of treating oversized content as clean', () => {
    assert.throws(() => scanSecretContent('x'.repeat(1025), { maxBytes: 1024 }), /secret_scan_size_limit/);
  });
});
