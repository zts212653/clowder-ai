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

test("does not inherit another action's short-option meanings for implicit content", async () => {
  for (const args of [
    ['pr', 'comment', '123', '-e', '--body', 'explicit body'],
    ['pr', 'create', '-f', '--body', 'explicit body'],
    ['issue', 'create', '-w', '--body', 'explicit body'],
    ['pr', 'edit', '123'],
    ['pr', 'review', '123', '-c'],
  ])
    await assert.rejects(prepareSecretSafeSend('gh', args), /secret_send_implicit_content_unsupported/);
});

test('refuses outgoing commands and flags with no verified payload grammar', async () => {
  for (const args of [['ssh-key', 'add', body('opaque fixture content')], ['unclassified-extension']])
    await assert.rejects(prepareSecretSafeSend('gh', args), /secret_send_operation_unsupported/);
  await assert.rejects(
    prepareSecretSafeSend('gh', ['pr', 'review', '123', '--unclassified', '-F', body('safe body')]),
    /secret_send_option_unsupported/,
  );
});

test('refuses a conflicting option arity before the action instead of guessing', async () => {
  await assert.rejects(
    prepareSecretSafeSend('gh', ['pr', '-a', 'review', '123', '-F', body('safe body')]),
    /secret_send_operation_unresolved/,
  );
});

test('refuses credential-disclosure flag aliases without executing gh', async () => {
  for (const flag of ['-t', '-at', '--show-token=true'])
    await assert.rejects(
      prepareSecretSafeSend('gh', ['auth', 'status', flag]),
      /credential_disclosure_blocked_before_read/,
    );
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
  ]) {
    const prepared = await prepareSecretSafeSend('gh', args);
    leases.push(prepared);
    assert.deepEqual(prepared.args, args);
  }
});
