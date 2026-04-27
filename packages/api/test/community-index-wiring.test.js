import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

describe('community sync wiring in index.ts', () => {
  test('guards main api bootstrap against dropping community sync dependencies', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');

    assert.ok(source.includes('const fetchIssuesForSync = async (repo: string) => {'));
    assert.ok(source.includes('const fetchPrsForSync = async (repo: string) => {'));
    assert.ok(source.includes('const fetchPrReviewsForSync = async (_repo: string, prNumber: number) => {'));
    assert.ok(source.includes('const communityPrStore = new InMemoryCommunityPrStore();'));
    assert.ok(
      source.includes('fetchIssues: fetchIssuesForSync'),
      'REGRESSION: communityIssueRoutes must receive fetchIssues for GitHub issue sync.',
    );
    assert.ok(
      source.includes('communityPrStore,'),
      'REGRESSION: communityIssueRoutes must receive a communityPrStore for board projection.',
    );
    assert.ok(
      source.includes('fetchPrs: fetchPrsForSync'),
      'REGRESSION: communityIssueRoutes must receive fetchPrs for GitHub PR sync.',
    );
    assert.ok(
      source.includes('fetchPrReviews: fetchPrReviewsForSync'),
      'REGRESSION: communityIssueRoutes must receive fetchPrReviews for review projection.',
    );
    assert.ok(
      source.includes('registry,'),
      'REGRESSION: communityIssueRoutes must keep callback auth wiring from the shared InvocationRegistry.',
    );
  });
});
