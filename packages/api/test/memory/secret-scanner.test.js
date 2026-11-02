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

  // Regression: the container project `clowder-ai` was blocked + purged because prose in
  // docs/features/F236-anchor-first-context-entry.md ("…correlation key = messageId/taskId/
  // sourceTool/previewEventId…") matched the high-entropy fallback. Documentation describing
  // a key name is not an assignment.
  it('does not flag prose that mentions a key mid-sentence (F236 regression)', () => {
    const content =
      'per-tool open-rate 需要 **preview-event ↔ drill-event 可 join 的事件模型**（correlation key = messageId/taskId/sourceTool/previewEventId）；**高基数 id 不能做 metric label**。\n';
    assert.equal(SecretScanner.scan(content, 'F236.md').length, 0);
  });

  // Upstream review on #1451 (issue #1450): once a credential key sits in explicit assignment
  // position, no value shape may be blanket-exempted — a real passphrase has exactly the shape of
  // an identifier enumeration. The F236 false positive is fixed by the key-position gate above,
  // not by a value-side exemption, so these chains are reported by design.
  it('flags a digit-free identifier chain in explicit assignment position (reviewed tradeoff)', () => {
    const content = '- key = messageId/taskId/sourceTool/previewEventId\n';
    const findings = SecretScanner.scan(content, 'notes.md');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'high-entropy-secret');
  });

  it('flags a digit-free path chain in explicit assignment position (reviewed tradeoff)', () => {
    const content = 'auth = docs/harness-feedback/eval-domains/publish\n';
    assert.equal(SecretScanner.scan(content, 'notes.md').length, 1);
  });

  it('flags a digit-free slash-separated passphrase (review counter-example)', () => {
    const content = 'password = "CorrectHorse/BatteryStaple/PurpleCloud/Sunshine"\n';
    const findings = SecretScanner.scan(content, 'env.md');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'high-entropy-secret');
  });

  it('flags shell and PowerShell assignment forms (review counter-examples)', () => {
    const forms = [
      '$env:API_TOKEN = "Kj8sLq/2mNp9Rt/4vWx7YzAbCdEfGhIjKlMn"',
      'readonly API_TOKEN="Kj8sLq/2mNp9Rt/4vWx7YzAbCdEfGhIjKlMn"',
      'declare -x API_TOKEN="Kj8sLq/2mNp9Rt/4vWx7YzAbCdEfGhIjKlMn"',
      'export API_TOKEN="Kj8sLq/2mNp9Rt/4vWx7YzAbCdEfGhIjKlMn"',
      '  API_TOKEN="Kj8sLq/2mNp9Rt/4vWx7YzAbCdEfGhIjKlMn"',
    ];
    for (const form of forms) {
      const findings = SecretScanner.scan(`${form}\n`, 'env.md');
      assert.equal(findings.length, 1, `must flag: ${form}`);
      assert.equal(findings[0].type, 'high-entropy-secret');
    }
  });

  // Review on #1451 (round 2): widening the gate to shell prefixes dropped the JS/TS declaration
  // grammar it already had, and the braced PowerShell form never consumed its closing `}`.
  it('flags JS/TS declaration and braced PowerShell assignment forms (review counter-examples)', () => {
    const value = 'Kj8sLq2mNp9Rt4vWx7YzAbCdEfGhIjKlMnOpQrSt';
    const forms = [
      `const API_TOKEN = "${value}"`,
      `let apiKey = "${value}"`,
      `var authSecret = "${value}"`,
      `export const API_TOKEN = "${value}"`,
      `\${env:API_TOKEN} = "${value}"`,
    ];
    for (const form of forms) {
      const findings = SecretScanner.scan(`${form}\n`, 'env.md');
      assert.equal(findings.length, 1, `must flag: ${form}`);
      assert.equal(findings[0].type, 'high-entropy-secret');
    }
  });

  // Same family as the counter-examples above: a bare shell variable is an assignment target too.
  // `$VAR` was caught by the pre-anchoring baseline and regressed when the gate was anchored;
  // `${VAR}` was never caught, so both are pinned here.
  it('flags bare and braced shell variable assignments', () => {
    const value = 'Kj8sLq2mNp9Rt4vWx7YzAbCdEfGhIjKlMnOpQrSt';
    for (const form of [`$API_TOKEN = "${value}"`, `\${API_TOKEN} = "${value}"`]) {
      const findings = SecretScanner.scan(`${form}\n`, 'env.md');
      assert.equal(findings.length, 1, `must flag: ${form}`);
      assert.equal(findings[0].type, 'high-entropy-secret');
    }
  });

  // Same family again: the variable decoration must be generic, not a hardcoded `env:` scope.
  // `$script:`/`$global:`/`$private:`/`$using:`/bare `env:` were all reported by the pre-anchoring
  // baseline and regressed when the gate was anchored + narrowed to `env:`.
  it('flags scope-qualified shell/PowerShell variables and bare scope prefixes', () => {
    const value = 'Kj8sLq2mNp9Rt4vWx7YzAbCdEfGhIjKlMnOpQrSt';
    const forms = [
      `$script:API_TOKEN = "${value}"`,
      `$global:API_TOKEN = "${value}"`,
      `$private:API_TOKEN = "${value}"`,
      `$using:API_TOKEN = "${value}"`,
      `env:API_TOKEN = "${value}"`,
      `script:API_TOKEN = "${value}"`,
    ];
    for (const form of forms) {
      const findings = SecretScanner.scan(`${form}\n`, 'env.md');
      assert.equal(findings.length, 1, `must flag: ${form}`);
      assert.equal(findings[0].type, 'high-entropy-secret');
    }
  });

  // The gate is now shape-generic: any whitespace-free decoration before the assignment operator is
  // accepted, so new spellings cannot regress one by one (const/let/var → $VAR → $scope: → [type]$VAR).
  it('flags arbitrary variable decoration before the assignment operator', () => {
    const value = 'Kj8sLq2mNp9Rt4vWx7YzAbCdEfGhIjKlMnOpQrSt';
    const forms = [
      `[string]$API_TOKEN = "${value}"`,
      `[string]$API_TOKEN="${value}"`,
      `$script:API_TOKEN = "${value}"`,
      `$global:API_TOKEN = "${value}"`,
      `env:API_TOKEN = "${value}"`,
      `"API_TOKEN" = "${value}"`,
      `$cfg.apiKey = "${value}"`,
    ];
    for (const form of forms) {
      const findings = SecretScanner.scan(`${form}\n`, 'env.md');
      assert.equal(findings.length, 1, `must flag: ${form}`);
      assert.equal(findings[0].type, 'high-entropy-secret');
    }
  });

  // A documentation link after a key-ish label must not be reported. Scanning the line for *any*
  // `[:=]` let the `:` of `https:` supply a 32+ character "value", and a finding here means the
  // whole collection is purged and the project is pinned to `failed`.
  it('does not flag a key label followed by a documentation URL', () => {
    const lines = [
      'api_key: https://console.cloud.google.com/apis/credentials',
      'token: https://github.com/settings/tokens/new',
      'secret = https://example.com/a/very/long/path/to/some/resource',
      'api_key = "short" # then https://example.com/a/very/long/path/here',
    ];
    for (const line of lines) {
      assert.equal(SecretScanner.scan(`${line}\n`, 'docs.md').length, 0, `must not flag: ${line}`);
    }
  });

  // The baseline gate was not anchored, so it reported assignments behind Markdown markers and
  // preceding shell assignments; the anchored gate must keep them.
  it('flags assignments behind markdown markers and preceding shell assignments', () => {
    const value = 'Kj8sLq2mNp9Rt4vWx7YzAbCdEfGhIjKlMnOpQrSt';
    const forms = [
      `1. api_key = "${value}"`,
      `1) api_key = "${value}"`,
      `# api_key = "${value}"`,
      `+ api_key = "${value}"`,
      `- [ ] api_key = "${value}"`,
      `- [x] api_key = "${value}"`,
      `| api_key = "${value}" |`,
      `FOO=1 API_TOKEN="${value}"`,
    ];
    for (const form of forms) {
      const findings = SecretScanner.scan(`${form}\n`, 'env.md');
      assert.equal(findings.length, 1, `must flag: ${form}`);
      assert.equal(findings[0].type, 'high-entropy-secret');
    }
  });

  it('still flags assignment-style high-entropy secrets containing separators', () => {
    const content = 'token = "Kj8sLq/2mNp9Rt/4vWx7YzAbCdEfGhIjKlMn"\n';
    const findings = SecretScanner.scan(content, 'env.md');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'high-entropy-secret');
  });

  it('still flags namespaced assignment keys', () => {
    const content = 'cfg.apiKey = "a8f3b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9"\n';
    const findings = SecretScanner.scan(content, 'code.md');
    assert.equal(findings.length, 1);
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
