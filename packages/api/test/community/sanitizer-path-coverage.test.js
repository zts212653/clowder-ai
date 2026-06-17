import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

/**
 * F235 R6 P2-1: Sanitizer should redact broad range of Unix filesystem paths.
 * Previously only caught /Users, /home, /tmp.
 */

let sanitize;

describe('F235 R6: CommunityIssueSanitizer absolute path coverage', () => {
  // Load from compiled output
  before(async () => {
    const mod = await import('../../dist/domains/community/CommunityIssueSanitizer.js');
    sanitize = mod.sanitize;
  });

  // Paths that MUST be redacted
  const mustRedact = [
    ['/home/user/cat-cafe', '/Users (macOS home)'],
    ['/home/deploy/.config/secrets', '/home (Linux home)'],
    ['/tmp/cat-cafe-review/sandbox', '/tmp (temp)'],
    ['/var/log/cat-cafe/api.log', '/var (cloud R6 finding)'],
    ['/opt/cat-cafe/dist/index.js', '/opt (cloud R6 finding)'],
    ['/workspace/cat-cafe/packages', '/workspace (cloud R6 finding)'],
    ['/usr/local/bin/node', '/usr (system)'],
    ['/etc/nginx/conf.d/cat-cafe.conf', '/etc (system config)'],
    ['/root/.ssh/id_rsa', '/root (root home)'],
    ['/srv/cat-cafe/data', '/srv (service data)'],
    ['/mnt/data/backups', '/mnt (mount point)'],
    ['/run/user/1000/pulse', '/run (runtime)'],
    ['/proc/1234/status', '/proc (procfs)'],
    ['/sys/class/net/eth0', '/sys (sysfs)'],
    ['/nix/store/abc123-node', '/nix (NixOS)'],
    ['/snap/node/1234/bin/node', '/snap (snap packages)'],
    ['/lib/systemd/system/cat-cafe.service', '/lib (system libs)'],
    ['/lib64/ld-linux-x86-64.so.2', '/lib64 (64-bit libs)'],
    ['/boot/vmlinuz', '/boot (boot)'],
    ['/media/usb/backup.tar', '/media (removable)'],
    ['/build/cat-cafe/output', '/build (build dir)'],
    ['/dist/packages/api/index.js', '/dist (dist dir)'],
  ];

  for (const [path, label] of mustRedact) {
    it(`redacts ${label}: ${path}`, () => {
      const result = sanitize(`Title with ${path}`, `Body\n${path}\nmore`);
      assert.ok(
        !result.bodyMarkdown.includes(path),
        `Path "${path}" should be redacted but survived: ${result.bodyMarkdown}`,
      );
      assert.ok(result.redactedFields.includes('absolutePath'));
    });
  }

  // Paths that must NOT be false-positived
  const mustPreserve = [
    ['https://github.com/clowder-ai/cat-cafe/issues/347', 'GitHub URL'],
    ['http://localhost:3003/api/issues', 'localhost URL'],
    ['/api/community-issue-drafts/cid_123/publish', 'API route path'],
  ];

  for (const [text, label] of mustPreserve) {
    it(`preserves ${label}: ${text}`, () => {
      const result = sanitize('Clean title', `Visit ${text} for details`);
      // The text should survive (not be redacted as absolutePath)
      // Note: other patterns (like cid_ prefix) may still redact parts
      assert.ok(!result.redactedFields.includes('absolutePath'), `"${text}" should not trigger absolutePath redaction`);
    });
  }

  // ── R7 audit: Windows paths ─────────────────────────────────
  const windowsPaths = [
    ['C:\\Users\\Alice\\projects\\cat-cafe', 'Windows drive letter'],
    ['D:\\Projects\\cat-cafe\\dist', 'D drive'],
    ['\\\\server\\share\\data\\secrets', 'UNC path'],
  ];

  for (const [path, label] of windowsPaths) {
    it(`redacts ${label}: ${path}`, () => {
      const result = sanitize('Title', `Error at ${path}`);
      assert.ok(!result.bodyMarkdown.includes(path), `Windows path "${path}" should be redacted`);
      assert.ok(result.redactedFields.includes('absolutePath'));
    });
  }

  // ── R7 audit: hyphenated API keys ──────────────────────────
  const hyphenatedKeys = [
    ['sk-ant-api03-abcdefghijklmnopqrst', 'Anthropic sk-ant key'],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz', 'OpenAI sk-proj key'],
  ];

  for (const [key, label] of hyphenatedKeys) {
    it(`redacts ${label}: ${key}`, () => {
      const result = sanitize('Title', `Key: ${key}`);
      assert.ok(!result.bodyMarkdown.includes(key), `Key "${key}" should be redacted`);
      assert.ok(result.redactedFields.includes('apiKey'));
    });
  }

  // ── R7 audit: AWS access keys ──────────────────────────────
  it('redacts AWS access key ID', () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const result = sanitize('Title', `AWS_ACCESS_KEY_ID=${awsKey}`);
    assert.ok(!result.bodyMarkdown.includes(awsKey), 'AWS key should be redacted');
    assert.ok(result.redactedFields.includes('apiKey'));
  });
});
