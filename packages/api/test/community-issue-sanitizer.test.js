import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * F235 KD-4: Whitelist + fail-closed sanitizer.
 * Forbidden: threadId, userId, catId, invocationId, cardMessageId, Redis keys,
 *            callback tokens, session IDs, absolute paths, API keys.
 */
describe('CommunityIssueSanitizer', () => {
  /** @returns {Promise<typeof import('../dist/domains/community/CommunityIssueSanitizer.js')>} */
  const loadModule = () => import('../dist/domains/community/CommunityIssueSanitizer.js');

  describe('clean content passes through', () => {
    it('returns clean title and body unchanged', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize(
        'Permission prompts too frequent',
        '## Problem\nUser cancelled 4 times in 60 seconds during npm install.',
      );
      assert.equal(result.title, 'Permission prompts too frequent');
      assert.equal(result.bodyMarkdown, '## Problem\nUser cancelled 4 times in 60 seconds during npm install.');
      assert.equal(result.passed, true);
      assert.deepEqual(result.redactedFields, []);
    });
  });

  describe('threadId patterns', () => {
    it('redacts thread_xxx from body', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Clean title', 'Issue in thread_abc123def456 session');
      assert.ok(!result.bodyMarkdown.includes('thread_abc123def456'), 'threadId should be redacted');
      assert.ok(result.bodyMarkdown.includes('[redacted]'));
      assert.ok(result.redactedFields.includes('threadId'));
      assert.equal(result.passed, true);
    });

    it('redacts thread_xxx from title', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Bug in thread_xyz789', 'Clean body');
      assert.ok(!result.title.includes('thread_xyz789'));
      assert.ok(result.redactedFields.includes('threadId'));
    });
  });

  describe('userId patterns', () => {
    it('redacts usr_xxx from body', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Reported by usr_abc123');
      assert.ok(!result.bodyMarkdown.includes('usr_abc123'));
      assert.ok(result.redactedFields.includes('userId'));
    });
  });

  describe('catId / invocationId patterns', () => {
    it('redacts common catId formats', async () => {
      const { sanitize } = await loadModule();
      // catIds from the roster: opus, sonnet, codex, gpt52, etc.
      const result = sanitize('Title', 'catId=opus invocationId=0001780508313338');
      assert.ok(!result.bodyMarkdown.includes('invocationId=0001780508313338'));
      assert.ok(result.redactedFields.includes('invocationId'));
    });
  });

  describe('frustration issue IDs', () => {
    it('redacts fi_xxx patterns', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Source: fi_lw2abc123xyz');
      assert.ok(!result.bodyMarkdown.includes('fi_lw2abc123xyz'));
      assert.ok(result.redactedFields.includes('issueId'));
    });
  });

  describe('Redis key patterns', () => {
    it('redacts frustration-issue:xxx keys', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Key: frustration-issue:fi_abc123');
      assert.ok(!result.bodyMarkdown.includes('frustration-issue:fi_abc123'));
      assert.ok(result.redactedFields.includes('redisKey'));
    });

    it('redacts community-issue-draft:xxx keys', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Key: community-issue-draft:cid_abc');
      assert.ok(!result.bodyMarkdown.includes('community-issue-draft:cid_abc'));
    });
  });

  describe('absolute paths', () => {
    it('redacts /home/user paths', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'File at /home/user/cat-cafe/src/index.ts');
      assert.ok(!result.bodyMarkdown.includes('/home/user'));
      assert.ok(result.redactedFields.includes('absolutePath'));
    });

    it('redacts /home/xxx paths', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Log at /home/user/.config/cat-cafe/debug.log');
      assert.ok(!result.bodyMarkdown.includes('/home/user'));
    });
  });

  describe('API keys and tokens', () => {
    it('redacts GitHub PAT tokens', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Token: ghp_1234567890abcdefghijklmnopqrstuvwxyz');
      assert.ok(!result.bodyMarkdown.includes('ghp_'));
      assert.ok(result.redactedFields.includes('apiKey'));
    });

    it('redacts sk- prefixed keys', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Key: sk-abc123def456ghi789jkl012mno345pqr');
      assert.ok(!result.bodyMarkdown.includes('sk-abc123'));
    });
  });

  describe('session IDs', () => {
    it('redacts session_xxx patterns', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Session: session_abc123def');
      assert.ok(!result.bodyMarkdown.includes('session_abc123def'));
      assert.ok(result.redactedFields.includes('sessionId'));
    });
  });

  describe('callback tokens', () => {
    it('redacts callback token patterns', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'X-Callback-Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx');
      assert.ok(!result.bodyMarkdown.includes('eyJhbGciOiJIUzI1NiJ9'));
      assert.ok(result.redactedFields.includes('callbackToken'));
    });
  });

  describe('multiple patterns in one text', () => {
    it('redacts all forbidden patterns', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Bug report', 'thread_abc in /home/user/code with fi_xyz123 and usr_test');
      assert.ok(!result.bodyMarkdown.includes('thread_abc'));
      assert.ok(!result.bodyMarkdown.includes('/home/user'));
      assert.ok(!result.bodyMarkdown.includes('fi_xyz123'));
      assert.ok(!result.bodyMarkdown.includes('usr_test'));
      assert.equal(result.passed, true);
    });
  });

  describe('cid_ draft IDs', () => {
    it('redacts cid_xxx patterns', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Draft: cid_abc123xyz');
      assert.ok(!result.bodyMarkdown.includes('cid_abc123xyz'));
      assert.ok(result.redactedFields.includes('draftId'));
    });
  });

  describe('cardMessageId patterns', () => {
    it('redacts msg_xxx patterns', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Card: msg_abc123def456');
      assert.ok(!result.bodyMarkdown.includes('msg_abc123def456'));
      assert.ok(result.redactedFields.includes('messageId'));
    });
  });

  // ── P1-3 review fixes: expanded forbidden patterns ──

  describe('default-user literal', () => {
    it('redacts default-user as userId', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'Logged in as default-user');
      assert.ok(!result.bodyMarkdown.includes('default-user'));
      assert.ok(result.redactedFields.includes('userId'));
    });
  });

  describe('catId assignment patterns', () => {
    it('redacts catId=gpt52', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'catId=gpt52 handled it');
      assert.ok(!result.bodyMarkdown.includes('catId=gpt52'));
      assert.ok(result.redactedFields.includes('catId'));
    });

    it('redacts catId: opus in JSON-like context', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'assigned to catId: opus-48');
      assert.ok(!result.bodyMarkdown.includes('catId: opus-48'));
      assert.ok(result.redactedFields.includes('catId'));
    });
  });

  describe('timestamp-based invocation IDs', () => {
    it('redacts 16-digit-dash-6digit-dash-hex pattern', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'invocation 0001781578946765-000248-88bb60cb');
      assert.ok(!result.bodyMarkdown.includes('0001781578946765-000248-88bb60cb'));
      assert.ok(result.redactedFields.includes('invocationId'));
    });
  });

  describe('debugRef patterns', () => {
    it('redacts debugRef=xxx', async () => {
      const { sanitize } = await loadModule();
      const result = sanitize('Title', 'debugRef=abc123def456');
      assert.ok(!result.bodyMarkdown.includes('debugRef=abc123def456'));
      assert.ok(result.redactedFields.includes('debugRef'));
    });
  });
});
