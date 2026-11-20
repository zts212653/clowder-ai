import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { secretShellDenial } from '../native-secret-shell.mjs';
import { isGhHelpRequest } from './secret-gh-options.mjs';
import { prepareSecretSafeSend } from './secret-outbound-args.mjs';

const root = mkdtempSync(join(tmpdir(), 'f306-gh-query-'));
const delegate = join(root, 'gh');
const capture = join(root, 'argv.json');
writeFileSync(
  delegate,
  `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.QUERY_CAPTURE,JSON.stringify(process.argv.slice(2)));\n`,
);
chmodSync(delegate, 0o755);
after(() => rmSync(root, { recursive: true, force: true }));

test('help and publication pipelines both reach the managed sender', () => {
  for (const command of [
    'gh run rerun --help | head -65',
    "gh pr merge --help | rg -n -C 2 'match-head|squash|delete-branch|admin'",
    'gh --repo o/r pr merge --help | head -20',
    'gh auth status; gh run rerun --help | head -65; gh api repos/o/r',
    'gh pr merge --subject --help --squash 123 | cat',
  ]) {
    assert.equal(secretShellDenial(command, process.cwd()), null, command);
  }
});

test('managed argument inspection preserves real help and label query arguments', async () => {
  for (const args of [
    ['run', 'rerun', '--help'],
    ['--repo', 'o/r', 'run', 'rerun', '--help'],
    ['pr', 'merge', '--help'],
    ['pr', 'create', '--dry-run', '--help'],
    ['pr', 'review', '--request-changes', '--help'],
    ['pr', 'comment', '123', '--create-if-none', '--help'],
    ['gist', 'create', '--public', '--help'],
    ['label', 'list', '--search', 'hotfix', '--json', 'name', '--limit', '50'],
    ['label', 'list', '--repo', 'o/r', '--search', '--help', '--json', 'name'],
  ]) {
    const prepared = await prepareSecretSafeSend('gh', args);
    try {
      assert.deepEqual(prepared.args, args);
    } finally {
      prepared.dispose();
    }
  }
});

test('the actual wrapper delegates the natural query without external execution', () => {
  for (const args of [
    ['run', 'rerun', '--help'],
    ['pr', 'create', '--dry-run', '--help'],
    ['label', 'list', '--search', 'hotfix', '--json', 'name', '--limit', '50'],
    ['gist', 'clone', 'fixture-id', 'local checkout'],
    ['gist', 'delete', 'fixture-id'],
  ]) {
    const result = spawnSync(process.execPath, [resolve('scripts/guarded-bin/gh'), ...args], {
      cwd: root,
      env: { ...process.env, HOME: root, CAT_CAFE_REAL_GH_PATH: delegate, QUERY_CAPTURE: capture },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), args);
  }
});

test('help text as option value, post-terminator data and actual writes keep their boundaries', async () => {
  for (const command of [
    '/opt/unmanaged/gh pr merge --subject --help --squash 123 | cat',
    'NODE_OPTIONS=--import=/tmp/unproved gh pr merge --help | cat',
  ])
    assert.equal(secretShellDenial(command, process.cwd()), 'secret_send_requires_managed_command', command);
  for (const args of [
    ['run', 'rerun', '123', '--failed'],
    ['run', 'rerun', '--job', '--help'],
    ['run', 'rerun', '--', '--help'],
    ['label', 'create', '--name', 'bug'],
  ]) {
    const prepared = await prepareSecretSafeSend('gh', args);
    try {
      assert.deepEqual(prepared.args, args);
    } finally {
      prepared.dispose();
    }
  }
  const secret = ['ghp', '_', 'K'.repeat(36)].join('');
  await assert.rejects(prepareSecretSafeSend('gh', ['run', 'rerun', '--help', secret]), /secret_content_detected/);
});

test('help uses each operation option arity and the final help boolean', () => {
  for (const args of [
    ['pr', 'create', '--title', '--help'],
    ['pr', 'merge', '--subject=--help'],
    ['pr', 'merge', '-t--help'],
    ['pr', 'merge', '--match-head-commit', '--help'],
    ['issue', 'edit', '--add-sub-issue', '--help'],
    ['gist', 'view', '--filename', '--help'],
    ['run', 'rerun', '-j--help'],
    ['auth', 'status', '-h', '--help'],
    ['api', '--jq', '--help'],
    ['pr', 'merge', '--', '--help'],
    ['pr', 'merge', '--help', '-h=false'],
    ['run', 'rerun', '--help=false'],
    ['unknown', 'extension', '--help'],
  ])
    assert.equal(isGhHelpRequest(args), false, JSON.stringify(args));
  for (const args of [
    ['pr', 'merge', '-sh'],
    ['pr', 'merge', '-h=false', '--help'],
    ['run', 'rerun', '--help=true'],
    ['api', '--help'],
    ['auth', 'status', '--help'],
    ['pr', 'new', '--help'],
    ['gist', 'new', '--help'],
    ['--help'],
    ['pr', '--help'],
  ])
    assert.equal(isGhHelpRequest(args), true, JSON.stringify(args));
  for (const value of ['1', 't', 'T', 'TRUE', 'true', 'True']) {
    const args = ['run', 'rerun', `--help=${value}`];
    assert.equal(isGhHelpRequest(args), true, JSON.stringify(args));
    assert.equal(secretShellDenial(`gh run rerun --help=${value} | cat`, process.cwd()), null);
  }
});

test('disabled help cannot stand in for an explicit mutation payload', async () => {
  for (const args of [
    ['pr', 'create', '--help=false'],
    ['issue', 'comment', '1', '--help=false'],
    ['gist', 'edit', '123', '--help=false'],
  ])
    await assert.rejects(prepareSecretSafeSend('gh', args), /secret_send_implicit_content_unsupported/);
});
