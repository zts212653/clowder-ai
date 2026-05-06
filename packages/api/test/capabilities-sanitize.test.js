// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { sanitizeArgsForDisplay, sanitizeUrlForDisplay } = await import('../dist/routes/capabilities.js');

describe('sanitizeArgsForDisplay', () => {
  it('redacts value after -s flag', () => {
    const result = sanitizeArgsForDisplay(['-s', 'sk-secret-token-123']);
    assert.deepEqual(result, ['-s', '••••••']);
  });

  it('redacts value after --token flag', () => {
    const result = sanitizeArgsForDisplay(['--token', 'ghp_abc123']);
    assert.deepEqual(result, ['--token', '••••••']);
  });

  it('redacts flag=value format for secret flags', () => {
    const result = sanitizeArgsForDisplay(['--secret=my-secret-value']);
    assert.deepEqual(result, ['--secret=••••••']);
  });

  it('redacts args matching token patterns', () => {
    const result = sanitizeArgsForDisplay(['run', 'sk-proj-ABC123']);
    assert.deepEqual(result, ['run', '••••••']);
  });

  it('preserves non-secret args', () => {
    const result = sanitizeArgsForDisplay(['node', 'dist/index.js', '--port', '3000']);
    assert.deepEqual(result, ['node', 'dist/index.js', '--port', '3000']);
  });

  it('handles npx-style args without redaction', () => {
    const result = sanitizeArgsForDisplay(['-y', '@playwright/mcp@latest']);
    assert.deepEqual(result, ['-y', '@playwright/mcp@latest']);
  });

  it('handles empty args', () => {
    assert.deepEqual(sanitizeArgsForDisplay([]), []);
  });

  it('redacts value after --client-secret flag', () => {
    const result = sanitizeArgsForDisplay(['--client-secret', 'abc123']);
    assert.deepEqual(result, ['--client-secret', '••••••']);
  });

  it('redacts --client-secret=value format', () => {
    const result = sanitizeArgsForDisplay(['--client-secret=abc123']);
    assert.deepEqual(result, ['--client-secret=••••••']);
  });

  it('redacts ENV_LIKE_SECRET=value args', () => {
    const result = sanitizeArgsForDisplay(['GITHUB_PERSONAL_ACCESS_TOKEN=ghp_abc123']);
    assert.deepEqual(result, ['GITHUB_PERSONAL_ACCESS_TOKEN=••••••']);
  });

  it('redacts ghp_ prefixed args', () => {
    const result = sanitizeArgsForDisplay(['--config', 'ghp_1234567890abcdef']);
    assert.deepEqual(result, ['--config', '••••••']);
  });

  it('redacts --auth-token flag', () => {
    const result = sanitizeArgsForDisplay(['--auth-token', 'Bearer xyz']);
    assert.deepEqual(result, ['--auth-token', '••••••']);
  });

  it('redacts Bearer prefixed args', () => {
    const result = sanitizeArgsForDisplay(['Bearer eyJhbGciOiJIUzI1NiJ9']);
    assert.deepEqual(result, ['••••••']);
  });

  it('redacts value after --private-key flag', () => {
    const result = sanitizeArgsForDisplay(['--private-key', 'abc123']);
    assert.deepEqual(result, ['--private-key', '••••••']);
  });

  it('redacts --client-key=value format', () => {
    const result = sanitizeArgsForDisplay(['--client-key=abc123']);
    assert.deepEqual(result, ['--client-key=••••••']);
  });

  it('redacts Authorization: Bearer header-like arg', () => {
    const result = sanitizeArgsForDisplay(['Authorization: Bearer abc123']);
    assert.deepEqual(result, ['••••••']);
  });

  it('redacts arg containing Bearer mid-string', () => {
    const result = sanitizeArgsForDisplay(['--header', 'Authorization: Bearer xyz']);
    assert.deepEqual(result, ['--header', '••••••']);
  });

  it('does not redact non-secret flags containing key substring', () => {
    const result = sanitizeArgsForDisplay(['--monkey', 'banana', '--keyboard', 'us']);
    assert.deepEqual(result, ['--monkey', 'banana', '--keyboard', 'us']);
  });
});

describe('sanitizeUrlForDisplay', () => {
  it('redacts password in URL', () => {
    const result = sanitizeUrlForDisplay('http://user:secret@example.com/path');
    assert.ok(!result.includes('secret'), 'password must not appear in output');
    assert.ok(!result.includes('user'), 'username must be redacted');
    assert.ok(result.includes('••••••'), 'redacted placeholder must appear');
    assert.ok(result.includes('example.com'));
  });

  it('redacts token query params', () => {
    const result = sanitizeUrlForDisplay('http://example.com/api?token=abc123&name=test');
    assert.ok(result.includes('token='));
    assert.ok(!result.includes('abc123'));
    assert.ok(result.includes('name=test'));
  });

  it('redacts api_key query params', () => {
    const result = sanitizeUrlForDisplay('http://example.com?api_key=xyz');
    assert.ok(!result.includes('xyz'));
  });

  it('preserves clean URLs unchanged', () => {
    const result = sanitizeUrlForDisplay('http://localhost:3000/mcp');
    assert.equal(result, 'http://localhost:3000/mcp');
  });

  it('handles invalid URLs gracefully', () => {
    assert.equal(sanitizeUrlForDisplay('not-a-url'), 'not-a-url');
  });
});
