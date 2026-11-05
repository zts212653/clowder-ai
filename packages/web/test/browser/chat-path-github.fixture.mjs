import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Only external GitHub CLI bytes are controlled; the real owner/root admission and reference/diff readers run. */
export async function installChatPathGitHubFixture(directory, baseSha, headSha) {
  const responses = {};
  const referenceRepo = 'zts212653/clowder-ai';
  for (const [repo, number] of [
    ['controlled-fixture/path-reference-workspace', 5961],
    [referenceRepo, 5963],
  ]) {
    responses[JSON.stringify(['api', `repos/${repo}/pulls/${number}`])] = {
      number,
      html_url: `https://github.com/${repo}/pull/${number}`,
      title: 'Controlled path reference',
      state: 'closed',
      merged_at: '2026-10-22T16:18:24Z',
      additions: 238,
      deletions: 208,
      changed_files: number === 5961 ? 11 : 2,
      user: { login: 'specimen' },
      base: { sha: baseSha, repo: { full_name: repo } },
      head: { sha: headSha, repo: { full_name: repo } },
    };
    responses[
      JSON.stringify(['pr', 'view', String(number), '--repo', repo, '--json', 'headRefOid,statusCheckRollup'])
    ] = {
      headRefOid: headSha,
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    };
  }
  responses[JSON.stringify(['api', `repos/${referenceRepo}/compare/${baseSha}...${headSha}?per_page=100&page=1`])] = {
    base_commit: { sha: baseSha },
    merge_base_commit: { sha: baseSha },
    files: ['report.md', 'actions.md'].map((name) => ({
      filename: `docs/path-reference/${name}`,
      status: 'added',
      patch: `@@ -0,0 +1 @@\n+# Controlled ${name}`,
    })),
  };
  const bin = path.join(directory, 'github-transport');
  await mkdir(bin);
  const cli = path.join(bin, 'gh');
  await writeFile(
    cli,
    `#!${process.execPath}\nconst responses = ${JSON.stringify(responses)};\nconst key = JSON.stringify(process.argv.slice(2));\nif (!Object.hasOwn(responses, key)) { process.stderr.write('Unexpected controlled GitHub read: ' + key); process.exit(1); }\nprocess.stdout.write(JSON.stringify(responses[key]));\n`,
  );
  await chmod(cli, 0o755);
  const prior = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prior ?? ''}`;
  return () => {
    assert.equal(process.env.PATH?.split(path.delimiter)[0], bin, 'the fixture owns its CLI transport until cleanup');
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  };
}
