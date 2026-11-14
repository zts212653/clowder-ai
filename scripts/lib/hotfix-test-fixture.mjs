import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = process.env.HOTFIX_TEST_CLI || fileURLToPath(new URL('../check-hotfix-pattern.mjs', import.meta.url));

// Real Git history and CLI; only gh is controlled, so tests never mutate GitHub.
export function hotfixFixture(t, { title = 'feat: add behavior', subject = 'feat: add behavior', files } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hotfix-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const remote = join(root, 'remote.git');
  const metadataPath = join(root, 'metadata.json');
  const logPath = join(root, 'gh.jsonl');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['PR_NUMBER', 'HOTFIX_BASE', 'HOTFIX_HEAD', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
    delete env[key];
  }
  function git(...args) {
    return execFileSync('git', ['-C', repo, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  mkdirSync(repo);
  mkdirSync(bin);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Hotfix fixture');
  git('config', 'user.email', 'hotfix@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feature');
  for (const [name, content] of Object.entries(files || { 'a.js': 'export const result = 1;\n' })) {
    writeFileSync(join(repo, name), content);
  }
  git('add', '.');
  git('commit', '-qm', subject);
  const head = git('rev-parse', 'HEAD');
  execFileSync('git', ['init', '--bare', '-q', remote], { env });
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main', 'feature');
  git('config', 'remote.origin.url', 'https://github.com/example/hotfix-fixture.git');
  git('config', `url.${remote}.insteadOf`, 'https://github.com/example/hotfix-fixture.git');
  git('checkout', '-q', 'main');
  const metadata = {
    number: 12,
    url: 'https://github.com/example/hotfix-fixture/pull/12',
    title,
    baseRefOid: base,
    headRefOid: head,
  };
  writeFileSync(metadataPath, JSON.stringify(metadata));
  writeFileSync(logPath, '');
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const previous = readFileSync(process.env.HOTFIX_FIXTURE_LOG, 'utf8').trim().split('\\n').filter(Boolean);
appendFileSync(process.env.HOTFIX_FIXTURE_LOG, JSON.stringify(args) + '\\n');
if (process.env.HOTFIX_FIXTURE_FAIL === args[1]) { console.error('fixture gh read/write failure\\n{"hotfix":false}'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'view') {
  const meta = JSON.parse(readFileSync(process.env.HOTFIX_FIXTURE_METADATA, 'utf8'));
  if (process.env.HOTFIX_FIXTURE_DRIFT && previous.length > 0) meta.headRefOid = 'f'.repeat(40);
  console.log(args.includes('--jq') ? meta.title : JSON.stringify(meta));
} else if (args[0] !== 'pr' || args[1] !== 'edit') { console.error('unexpected fixture gh call'); process.exit(1); }
`,
    { mode: 0o755 },
  );
  function run(args = [], overrides = {}, cwd = repo) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...env,
        PATH: `${bin}:${env.PATH}`,
        HOTFIX_FIXTURE_LOG: logPath,
        HOTFIX_FIXTURE_METADATA: metadataPath,
        ...overrides,
      },
    });
    const last = result.stdout?.trim().split('\n').at(-1);
    let json;
    try {
      json = JSON.parse(last);
    } catch {
      /* A CLI failure must not emit a successful analysis. */
    }
    return { ...result, json };
  }
  return {
    root,
    repo,
    base,
    head,
    git,
    run,
    setMetadata(patch) {
      Object.assign(metadata, patch);
      writeFileSync(metadataPath, JSON.stringify(metadata));
    },
    clearCalls() {
      writeFileSync(logPath, '');
    },
    calls() {
      return readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}
