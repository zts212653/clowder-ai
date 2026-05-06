import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('SecretScanner', () => {
  let SecretScanner;

  before(async () => {
    ({ SecretScanner } = await import('../../dist/domains/memory/SecretScanner.js'));
  });

  it('detects AWS access key', () => {
    const content = 'config:\n  aws_key: AKIAIOSFODNN7EXAMPLE\n';
    const findings = SecretScanner.scan(content, 'config.md');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'aws-access-key');
  });

  it('detects GitHub personal access token (ghp_)', () => {
    const content = 'token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n';
    const findings = SecretScanner.scan(content, 'notes.md');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'github-token');
  });

  it('detects GitHub App tokens (ghs_, ghu_, ghr_) (R6-P1)', () => {
    const ghs = 'GITHUB_TOKEN=ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n';
    const ghu = 'token: ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n';
    const ghr = 'refresh = ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n';
    assert.equal(SecretScanner.scan(ghs, 'ci.md')[0].type, 'github-token');
    assert.equal(SecretScanner.scan(ghu, 'ci.md')[0].type, 'github-token');
    assert.equal(SecretScanner.scan(ghr, 'ci.md')[0].type, 'github-token');
  });

  it('detects generic high-entropy strings in key context', () => {
    const content = 'api_key = "a8f3b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9"\n';
    const findings = SecretScanner.scan(content, 'env.md');
    assert.ok(findings.length >= 1);
    assert.equal(findings[0].type, 'high-entropy-secret');
  });

  it('returns empty for safe content', () => {
    const content = '# Design Notes\n\nThis is a safe document about architecture.\n';
    const findings = SecretScanner.scan(content, 'design.md');
    assert.equal(findings.length, 0);
  });

  it('does not flag code examples inside fenced blocks', () => {
    const content = '# Tutorial\n\n```\nAKIAIOSFODNN7EXAMPLE\n```\n';
    const findings = SecretScanner.scan(content, 'tutorial.md');
    assert.equal(findings.length, 0);
  });

  it('reports file path and line number in finding', () => {
    const content = 'line1\nline2\naws_key: AKIAIOSFODNN7EXAMPLE\n';
    const findings = SecretScanner.scan(content, 'creds.md');
    assert.equal(findings[0].file, 'creds.md');
    assert.equal(findings[0].line, 3);
  });

  it('detects OpenAI key pattern', () => {
    const content = 'openai_key: sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456\n';
    const findings = SecretScanner.scan(content, 'config.md');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'openai-key');
  });

  it('detects private key header', () => {
    const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...\n';
    const findings = SecretScanner.scan(content, 'key.md');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'private-key');
  });

  it('scanBatch reports filesWithSecrets count', () => {
    const files = [
      { path: 'clean.md', content: '# Clean\n\nSafe.' },
      { path: 'dirty.md', content: '# Dirty\n\ntoken: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n' },
      { path: 'also-dirty.md', content: '# Also\n\nkey: AKIAIOSFODNN7EXAMPLE\n' },
    ];
    const result = SecretScanner.scanBatch(files);
    assert.equal(result.filesWithSecrets, 2);
    assert.ok(result.findings.length >= 2);
  });

  it('does not suppress real token when TODO appears in surrounding context (P1-C)', () => {
    const content = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij # TODO rotate this\n';
    const findings = SecretScanner.scan(content, 'config.md');
    assert.equal(findings.length, 1, 'TODO in context must not suppress a real token');
    assert.equal(findings[0].type, 'github-token');
  });
});
