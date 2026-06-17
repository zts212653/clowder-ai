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
    // F168 Phase C C0.2 (optional-dep 硬层守护): threadStore 是 routeAccepted Path 2
    // （narrator 推荐新建 thread）的强依赖。注释标记精确定位 communityIssueRoutes
    // register block，避免误匹配 index.ts 其它 register 的 threadStore。
    assert.ok(
      source.includes('threadStore, // F168 Phase C'),
      'REGRESSION: communityIssueRoutes must receive threadStore for narrator Path 2 (new-thread) routing — without it routeAccepted silently drops new-thread cases (F168 Phase C C0.1).',
    );
  });
});
