import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { prepareSecretSafeSend } from './secret-outbound-args.mjs';

const roots = [];
const leases = [];
const secret = () => ['ghp', '_', 'K'.repeat(36)].join('');
function body(text) {
  const root = mkdtempSync(join(tmpdir(), 'gh-command-body-'));
  roots.push(root);
  const path = join(root, 'body.md');
  writeFileSync(path, text);
  return path;
}
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const prefix of [
  ['pr', 'review', '123', '-a'],
  ['pr', 'review', '123', '-c'],
  ['pr', 'review', '123', '-r'],
  ['pr', 'create', '--body', 'explicit body', '-d'],
  ['pr', 'merge', '123', '-d'],
])
  test(`checks and freezes body files with the actual option roles: ${prefix.join(' ')}`, async () => {
    const path = body(secret());
    await assert.rejects(prepareSecretSafeSend('gh', [...prefix, '-F', path]), /secret_content_detected/);
    writeFileSync(path, 'safe review body');
    const prepared = await prepareSecretSafeSend('gh', [...prefix, '-F', path]);
    leases.push(prepared);
    assert.notEqual(prepared.args.at(-1), path);
    writeFileSync(path, secret());
    assert.equal(readFileSync(prepared.args.at(-1), 'utf8'), 'safe review body');
  });

test('classifies review short clusters and API typed fields before file inspection', async () => {
  const path = body(secret());
  for (const args of [
    ['pr', 'review', '123', `-aF${path}`],
    ['api', 'gists', `-iFbody=@${path}`],
  ])
    await assert.rejects(prepareSecretSafeSend('gh', args), /secret_content_detected/);
});

test('merge mode leaves the following body file visible to the scanner', async () => {
  const path = body(secret());
  for (const tail of [['-m', '--body-file', path], ['-m', '-F', path], [`-mF${path}`]]) {
    await assert.rejects(prepareSecretSafeSend('gh', ['pr', 'merge', ...tail, '7274']), /secret_content_detected/);
  }
  for (const args of [
    ['pr', 'merge', '7274', '--subject', '--help', '-m', '-F', path],
    ['pr', 'merge', '7274', '-m', '--body-file', path, '--', '--help'],
  ])
    await assert.rejects(prepareSecretSafeSend('gh', args), /secret_content_detected/);
});

test("does not inherit another action's short-option meanings for implicit content", async () => {
  for (const args of [
    ['pr', 'comment', '123', '-e', '--body', 'explicit body'],
    ['issue', 'create', '-w', '--body', 'explicit body'],
    ['pr', 'edit', '123'],
    ['pr', 'review', '123', '-c'],
  ])
    await assert.rejects(prepareSecretSafeSend('gh', args), /secret_send_implicit_content_unsupported/);
});

test('passes through new command and option spellings and still checks known body files', async () => {
  for (const args of [
    ['gist', 'clone', 'abc', 'local destination'],
    ['gist', 'delete', 'abc'],
    ['unclassified-extension', '--new-option=value', '--', '--body-file'],
  ]) {
    const prepared = await prepareSecretSafeSend('gh', args);
    leases.push(prepared);
    assert.deepEqual(prepared.args, args);
  }
  const path = body('safe body');
  const args = ['pr', 'review', '123', '--unclassified', '-F', path];
  const prepared = await prepareSecretSafeSend('gh', args);
  leases.push(prepared);
  assert.equal(prepared.args[3], '--unclassified');
  assert.equal(readFileSync(prepared.args.at(-1), 'utf8'), 'safe body');
  writeFileSync(path, secret());
  await assert.rejects(prepareSecretSafeSend('gh', args), /secret_content_detected/);
});

test('the previously closed SSH key command checks the actual uploaded file', async () => {
  const path = body('ssh-ed25519 fixture public key');
  const args = ['ssh-key', 'add', '--title', 'fixture', path];
  const prepared = await prepareSecretSafeSend('gh', args);
  leases.push(prepared);
  assert.equal(readFileSync(prepared.args.at(-1), 'utf8'), 'ssh-ed25519 fixture public key');
  writeFileSync(path, secret());
  await assert.rejects(prepareSecretSafeSend('gh', args), /secret_content_detected/);
});

test('passes unresolved prefix arguments to gh without guessing their roles', async () => {
  const args = ['pr', '-a', 'review', '123', '-F', body('safe body')];
  const prepared = await prepareSecretSafeSend('gh', args);
  leases.push(prepared);
  assert.deepEqual(prepared.args, args);
});

test('checks the same autofill spellings even when other switches precede the command', async () => {
  for (const flag of ['--fill', '--fill-first', '--fill-verbose', '-f']) {
    await assert.rejects(
      prepareSecretSafeSend('gh', ['pr', '-a', 'fixture-user', 'create', flag]),
      /secret_send_generated_pr_body/,
    );
  }
});

test('preserves local auth display flag aliases without executing gh', async () => {
  for (const flag of ['-t', '-at', '--show-token=true']) {
    const args = ['auth', 'status', flag];
    const prepared = await prepareSecretSafeSend('gh', args);
    leases.push(prepared);
    assert.deepEqual(prepared.args, args);
  }
});

test('preserves ordinary reads, explicit approval and metadata edits', async () => {
  for (const args of [
    ['pr', 'checks', '123', '--watch'],
    ['pr', 'view', '123', '--json', 'headRefOid', '--jq', '.headRefOid'],
    ['issue', 'list', '--label', 'help wanted'],
    ['run', 'view', '123', '--log-failed'],
    ['auth', 'status'],
    ['auth', 'status', '-h', 'github.example.invalid', '--json', 'hosts'],
    ['pr', 'review', '123', '-a'],
    ['pr', 'edit', '123', '--add-label', 'bug'],
    ['pr', 'create', '-a', 'fixture-user', '--body', 'explicit body'],
    ['pr', 'merge', '123', '--squash', '--match-head-commit', 'deadbeef'.repeat(5)],
    ['pr', 'merge', '7274', '-m'],
    ['gist', 'view', 'abc123', '-r'],
  ]) {
    const prepared = await prepareSecretSafeSend('gh', args);
    leases.push(prepared);
    assert.deepEqual(prepared.args, args);
  }
});

test('preserves release and workflow downloads as inbound files, not upload payloads', async () => {
  const destination = body(secret());
  for (const args of [
    ['release', 'download', 'v1', '--repo', 'fixture/project', '--pattern', '*.tgz', '--dir', '/tmp/downloads'],
    ['release', 'download', 'v1', '--archive=zip', '--output', destination],
    ['run', 'download', '123', '-R', 'fixture/project', '--name', 'artifact', '--dir', '/tmp/downloads'],
  ]) {
    const prepared = await prepareSecretSafeSend('gh', args);
    leases.push(prepared);
    assert.deepEqual(prepared.args, args, 'download destinations are outputs and must not be read or frozen');
  }
  await assert.rejects(
    prepareSecretSafeSend('gh', ['release', 'download', 'v1', '--pattern', secret()]),
    /secret_content_detected/,
  );
  await assert.rejects(
    prepareSecretSafeSend('gh', ['release', 'upload', 'v1', destination]),
    /secret_content_detected/,
  );
});

test('preserves repository clones, local destinations and forwarded git arguments', async () => {
  for (const args of [
    ['repo', 'clone', 'fixture/project'],
    ['repo', 'clone', 'https://github.com/fixture/project.git', '/tmp/clone-destination', '--no-upstream'],
    ['repo', 'clone', 'git@github.com:fixture/project.git', 'local checkout', '--', '--depth=1', '--branch', 'main'],
  ]) {
    const prepared = await prepareSecretSafeSend('gh', args);
    leases.push(prepared);
    assert.deepEqual(prepared.args, args, 'clone receives repository data; its destination is not an upload file');
  }
  await assert.rejects(
    prepareSecretSafeSend('gh', ['repo', 'clone', `https://${secret()}@github.com/fixture/project.git`]),
    /secret_content_detected/,
  );
});
