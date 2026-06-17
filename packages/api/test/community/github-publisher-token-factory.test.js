import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

/**
 * F235 R6 P1-1: GitHubIssuePublisher supports lazy token factory.
 * Verifies that the publisher resolves the token at publish time,
 * not at construction time — so late-binding plugin config works.
 */

let GitHubIssuePublisher;

describe('F235 R6: GitHubIssuePublisher token factory', () => {
  before(async () => {
    const mod = await import('../../dist/domains/community/GitHubIssuePublisher.js');
    GitHubIssuePublisher = mod.GitHubIssuePublisher;
  });

  it('accepts a static string token (backward compat)', () => {
    const pub = new GitHubIssuePublisher({ token: 'ghp_static123', repoAllowlist: ['a/b'] });
    assert.ok(pub);
  });

  it('throws at construction if static token is empty', () => {
    assert.throws(
      () => new GitHubIssuePublisher({ token: '', repoAllowlist: ['a/b'] }),
      (err) => err.message.includes('not configured'),
    );
  });

  it('accepts a factory function (lazy token)', () => {
    const pub = new GitHubIssuePublisher({ token: () => 'ghp_lazy456', repoAllowlist: ['a/b'] });
    assert.ok(pub);
  });

  it('does NOT throw at construction if factory returns undefined (deferred check)', () => {
    // Factory that returns undefined — should only fail at publish time
    const pub = new GitHubIssuePublisher({ token: () => undefined, repoAllowlist: ['a/b'] });
    assert.ok(pub);
  });

  it('factory token is resolved lazily at publish time', async () => {
    let tokenValue;
    const factory = () => tokenValue;
    const pub = new GitHubIssuePublisher({ token: factory, repoAllowlist: ['test/repo'] });

    // Initially undefined — publish should fail
    await assert.rejects(
      () => pub.publish({ repo: 'test/repo', title: 'T', body: 'B', labels: [] }),
      (err) => err.message.includes('not configured'),
    );

    // Set token — now the factory returns a value. But publish will fail
    // on the actual HTTP call (no real GitHub), which proves the token was resolved.
    tokenValue = 'ghp_nowset789';
    await assert.rejects(
      () => pub.publish({ repo: 'test/repo', title: 'T', body: 'B', labels: [] }),
      // Should get past the token check and fail on the HTTP call
      (err) => !err.message.includes('not configured'),
    );
  });
});
