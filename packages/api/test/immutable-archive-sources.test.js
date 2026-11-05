import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(readFileSync(new URL('../../shared/src/deployment-profiles.json', import.meta.url)));
const history = JSON.parse(
  readFileSync(new URL('../../shared/src/__tests__/fixtures/f314-history-publication-contract.json', import.meta.url)),
);
const commits = {
  cortex: ['35dfed114be3ca292aac304a888d4a9519d0dbea'],
  footballSmoke: ['bd50ba933054d9c8448cd3b5d3d2794784e4400d'],
  footballImage: ['bd50ba933054d9c8448cd3b5d3d2794784e4400d'],
  footballPublication: ['a9b28fa76235f5635bd9b2fd3a974a78afafc732'],
  caseSource: ['b242c8c8badfd4f6d2eba2016cc63cdaaa2e9768'],
  ownerReview: ['4042de718a6c0b00f0e846175c19b0271d7e000a'],
  storySource: ['b242c8c8badfd4f6d2eba2016cc63cdaaa2e9768'],
  historicalCommit: history.releases.flatMap((release) => release.commits.map((entry) => entry.fullSha ?? entry.sha)),
};
for (const profile of Object.keys(config.profiles)) {
  test(`${profile}: immutable archive links retain their source repository`, async (t) => {
    const child = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-loader',
        fileURLToPath(new URL('../../mcp-server/test/helpers/deployment-brand-loader.mjs', import.meta.url)),
        fileURLToPath(new URL('./helpers/immutable-archive-source-probe.mjs', import.meta.url)),
      ],
      {
        encoding: 'utf8',
        timeout: 20000,
        env: {
          ...process.env,
          TEST_DEPLOYMENT_PROFILE: profile,
          TEST_DEPLOYMENT_BRAND: '',
          TEST_DEPLOYMENT_REPOSITORY: '',
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const actual = JSON.parse(child.stdout);
    assert.equal(actual.deploymentRepository, config.profiles[profile].repositoryFullName);
    assert.equal(Object.keys(actual.projections).length, 8);
    for (const [kind, links] of Object.entries(actual.projections)) {
      await t.test(kind, () => {
        assert(links.length > 0);
        for (const href of links) {
          const url = new URL(href);
          assert.equal(url.origin, 'https://github.com');
          const [owner, repo, view, commit] = url.pathname.slice(1).split('/');
          assert.equal(owner, 'zts212653');
          assert.equal(repo, 'cat-cafe', `${kind} must retain the immutable source: ${href}`);
          assert(['blob', 'commit'].includes(view));
          assert.match(commit, /^[a-f0-9]{40}$/);
          assert(commits[kind].includes(commit), `${kind} must preserve the original commit: ${href}`);
        }
      });
    }
  });
}
