import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F222: FrustrationIssue types', () => {
  describe('generateFrustrationIssueId', () => {
    it('generates ID with fi_ prefix', async () => {
      const { generateFrustrationIssueId } = await import('../dist/types/frustration-issue.js');
      const id = generateFrustrationIssueId();
      assert.ok(id.startsWith('fi_'), `expected fi_ prefix, got: ${id}`);
    });

    it('generates unique IDs', async () => {
      const { generateFrustrationIssueId } = await import('../dist/types/frustration-issue.js');
      const id1 = generateFrustrationIssueId();
      const id2 = generateFrustrationIssueId();
      assert.notEqual(id1, id2, 'IDs should be unique');
    });
  });

  describe('createFrustrationIssue', () => {
    const validInput = {
      threadId: 'thread_abc123',
      userId: 'user_xyz',
      catId: 'cat-test',
      signalType: 'cli_error',
      signalDetail: { reasonCode: 'auth_failed', publicSummary: 'Auth failed' },
      context: {
        recentMessages: [{ role: 'user', content: 'help me', timestamp: 1000 }],
        errorLogs: 'Error: auth failed',
      },
    };

    it('creates issue with status=draft', async () => {
      const { createFrustrationIssue } = await import('../dist/types/frustration-issue.js');
      const issue = createFrustrationIssue(validInput);
      assert.equal(issue.status, 'draft');
    });

    it('generates issueId with fi_ prefix', async () => {
      const { createFrustrationIssue } = await import('../dist/types/frustration-issue.js');
      const issue = createFrustrationIssue(validInput);
      assert.ok(issue.issueId.startsWith('fi_'), `expected fi_ prefix, got: ${issue.issueId}`);
    });

    it('copies all input fields', async () => {
      const { createFrustrationIssue } = await import('../dist/types/frustration-issue.js');
      const issue = createFrustrationIssue(validInput);
      assert.equal(issue.threadId, 'thread_abc123');
      assert.equal(issue.userId, 'user_xyz');
      assert.equal(issue.catId, 'cat-test');
      assert.equal(issue.signalType, 'cli_error');
      assert.deepEqual(issue.signalDetail, validInput.signalDetail);
      assert.equal(issue.context.recentMessages.length, 1);
      assert.equal(issue.context.errorLogs, 'Error: auth failed');
    });

    it('sets createdAt timestamp', async () => {
      const { createFrustrationIssue } = await import('../dist/types/frustration-issue.js');
      const before = Date.now();
      const issue = createFrustrationIssue(validInput);
      const after = Date.now();
      assert.ok(issue.createdAt >= before && issue.createdAt <= after);
    });

    it('leaves confirmedAt and skippedAt undefined', async () => {
      const { createFrustrationIssue } = await import('../dist/types/frustration-issue.js');
      const issue = createFrustrationIssue(validInput);
      assert.equal(issue.confirmedAt, undefined);
      assert.equal(issue.skippedAt, undefined);
    });

    it('preserves optional invocationId', async () => {
      const { createFrustrationIssue } = await import('../dist/types/frustration-issue.js');
      const issue = createFrustrationIssue({ ...validInput, invocationId: 'inv_123' });
      assert.equal(issue.invocationId, 'inv_123');
    });

    it('rejects missing threadId', async () => {
      const { createFrustrationIssue } = await import('../dist/types/frustration-issue.js');
      assert.throws(() => createFrustrationIssue({ ...validInput, threadId: '' }), /threadId.*required/i);
    });

    it('rejects missing userId', async () => {
      const { createFrustrationIssue } = await import('../dist/types/frustration-issue.js');
      assert.throws(() => createFrustrationIssue({ ...validInput, userId: '' }), /userId.*required/i);
    });

    it('rejects missing catId', async () => {
      const { createFrustrationIssue } = await import('../dist/types/frustration-issue.js');
      assert.throws(() => createFrustrationIssue({ ...validInput, catId: '' }), /catId.*required/i);
    });
  });
});
