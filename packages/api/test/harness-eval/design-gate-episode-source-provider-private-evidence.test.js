import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { DesignGateEpisodeSourceProviderImpl } from '../../dist/infrastructure/harness-eval/design-gate/design-gate-episode-source-provider.js';

const HEAD = 'a21fd76826fd38401b44172ce551778ca29fdac0';
const MERGE = 'db0e818a0d49bca4deeea428e14236901cb4fc5a';
const LANDED = '76184494597686283c0999d6f6166d0096fd6d2e';
const REVIEW_MESSAGE_ID = '0001787501286658-000077-5d3e5e07';
const SOURCE_MAP_ID = 'f303-phase-c-pr3901';
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

test('committed #3901 source map resolves its real anchored admission and trigger refs', async () => {
  const provider = new DesignGateEpisodeSourceProviderImpl({
    repoRoot: REPO_ROOT,
    pullRequestReader: {
      resolve: async () => ({
        repoFullName: 'zts212653/cat-cafe',
        number: 3901,
        state: 'MERGED',
        headSha: HEAD,
        mergeSha: MERGE,
        body: `## Architecture ownership\n- Map delta: none\n## Validation\nExact target: \`${HEAD}\`\n- \`pnpm gate\` — PASS at exact HEAD`,
        changedFiles: [
          'packages/api/src/infrastructure/harness-eval/eval-cat-invocation.ts',
          'packages/mcp-server/src/tools/publish-verdict-tool.ts',
        ],
      }),
    },
    reviewMessageReader: {
      getById: async () => ({
        id: REVIEW_MESSAGE_ID,
        threadId: 'thread_mt5xeb8e7qs467i2',
        catId: 'opus-47',
        content: `Local Review Verdict: APPROVED\nExact HEAD: \`${HEAD}\``,
        extra: { localReviewVerdict: { verdict: 'approved', clientMessageId: 'review-f303-phase-c' } },
      }),
    },
    gitTruth: {
      isOriginMainAncestor: async (revision) => revision === LANDED || revision === MERGE,
      isAncestor: async (ancestor, descendant) => ancestor === MERGE && descendant === LANDED,
    },
  });

  const bundle = await provider.resolve({
    kind: 'design-gate-episode-source-map',
    sourceMapId: SOURCE_MAP_ID,
  });

  assert.equal(bundle.episodes[0].eligibility.eligible, true);
  assert.deepEqual(bundle.episodes[0].validation, { status: 'valid', reasons: [] });
});
