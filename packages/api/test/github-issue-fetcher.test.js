import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('mapGitHubIssue', () => {
  let mapGitHubIssue;

  before(async () => {
    ({ mapGitHubIssue } = await import('../dist/domains/community/GitHubIssueFetcher.js'));
  });

  describe('state mapping', () => {
    it('maps closed issue to closed', () => {
      const result = mapGitHubIssue({
        number: 1,
        title: 'x',
        state: 'closed',
        labels: [],
        comments: 0,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.state, 'closed');
    });

    it('maps open issue with 0 comments to unreplied', () => {
      const result = mapGitHubIssue({
        number: 2,
        title: 'x',
        state: 'open',
        labels: [],
        comments: 0,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.state, 'unreplied');
    });

    it('maps open issue with comments to discussing', () => {
      const result = mapGitHubIssue({
        number: 3,
        title: 'x',
        state: 'open',
        labels: [],
        comments: 3,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.state, 'discussing');
    });

    it('maps issue with accepted label to accepted', () => {
      const result = mapGitHubIssue({
        number: 4,
        title: 'x',
        state: 'open',
        labels: ['accepted'],
        comments: 1,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.state, 'accepted');
    });

    it('maps issue with needs-maintainer-decision to pending-decision', () => {
      const result = mapGitHubIssue({
        number: 5,
        title: 'x',
        state: 'open',
        labels: ['needs-maintainer-decision'],
        comments: 2,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.state, 'pending-decision');
    });

    it('maps issue with invalid label to declined', () => {
      const result = mapGitHubIssue({
        number: 6,
        title: 'x',
        state: 'open',
        labels: ['invalid'],
        comments: 0,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.state, 'declined');
    });

    it('maps issue with duplicate label to declined', () => {
      const result = mapGitHubIssue({
        number: 7,
        title: 'x',
        state: 'open',
        labels: ['duplicate'],
        comments: 0,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.state, 'declined');
    });

    it('maps issue with fixed-internal label to closed', () => {
      const result = mapGitHubIssue({
        number: 8,
        title: 'x',
        state: 'open',
        labels: ['fixed-internal'],
        comments: 1,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.state, 'closed');
    });
  });

  describe('issueType mapping', () => {
    it('maps bug label to bug', () => {
      const result = mapGitHubIssue({
        number: 10,
        title: 'x',
        state: 'open',
        labels: ['bug'],
        comments: 0,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.issueType, 'bug');
    });

    it('maps enhancement label to enhancement', () => {
      const result = mapGitHubIssue({
        number: 11,
        title: 'x',
        state: 'open',
        labels: ['enhancement'],
        comments: 0,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.issueType, 'enhancement');
    });

    it('maps question label to question', () => {
      const result = mapGitHubIssue({
        number: 12,
        title: 'x',
        state: 'open',
        labels: ['question'],
        comments: 0,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.issueType, 'question');
    });

    it('maps feature label to feature', () => {
      const result = mapGitHubIssue({
        number: 13,
        title: 'x',
        state: 'open',
        labels: ['feature'],
        comments: 0,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.issueType, 'feature');
    });

    it('defaults to feature when no type label', () => {
      const result = mapGitHubIssue({
        number: 14,
        title: 'x',
        state: 'open',
        labels: ['good first issue'],
        comments: 0,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.issueType, 'feature');
    });
  });

  describe('label priority', () => {
    it('accepted takes priority over comments count', () => {
      const result = mapGitHubIssue({
        number: 20,
        title: 'x',
        state: 'open',
        labels: ['accepted'],
        comments: 0,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.state, 'accepted');
    });

    it('declined takes priority over discussing', () => {
      const result = mapGitHubIssue({
        number: 21,
        title: 'x',
        state: 'open',
        labels: ['invalid', 'bug'],
        comments: 5,
        user: 'a',
        html_url: '',
      });
      assert.equal(result.state, 'declined');
    });
  });
});
