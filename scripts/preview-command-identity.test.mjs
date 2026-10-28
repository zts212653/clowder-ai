import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  observePreviewCommand,
  previewCommandGroupStatus,
  readBoundPreviewCommand,
  recordPreviewCommand,
} from './lib/preview-command-identity.mjs';

test('a real unclaimed build failure durably binds detached command identity and terminal group observation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'command-birth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const completionPath = join(realpathSync(root), 'completion.json');
  const command = [process.execPath, '-e', 'setTimeout(()=>process.exit(2), 500)'];
  const r = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./preview-process-lease-runner.mjs', import.meta.url)),
      '--expires-at',
      new Date(Date.now() + 60000).toISOString(),
      '--completion-path',
      completionPath,
      '--',
      ...command,
    ],
    { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8', timeout: 7000 },
  );
  assert.equal(r.status, 2, r.stderr);
  const completion = JSON.parse(readFileSync(completionPath));
  const bytes = readFileSync(`${completionPath}.command.json`);
  const birth = JSON.parse(bytes);
  assert.equal(completion.commandIdentity.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(birth.supervisorPid, completion.pid);
  assert.equal(birth.completionPath, completionPath);
  assert.deepEqual(birth.command, command);
  assert.equal(birth.identityStatus, 'observed');
  assert.equal(birth.pid, birth.processGroupId);
  assert.equal(birth.identity.parentPid, completion.pid);
  assert.ok(Number.isFinite(Date.parse(birth.identity.startedAt)));
  assert.equal(completion.commandGroupStatus, 'absent');
  assert.equal(completion.cleanupOwnerStatus, 'unclaimed');
  assert.equal(completion.cleanupExitCode, null);
  const record = { completionPath, pid: completion.pid, expiresAt: completion.expiresAt, command, cwd: root };
  assert.equal(readBoundPreviewCommand(record, completion).sha256, completion.commandIdentity.sha256);
  assert.throws(() => readBoundPreviewCommand({ ...record, pid: record.pid + 1 }, completion), /does not belong/);
  assert.throws(
    () =>
      readBoundPreviewCommand(record, {
        ...completion,
        commandIdentity: { ...completion.commandIdentity, sha256: 'changed' },
      }),
    /does not belong/,
  );
  for (const changed of [
    { ...birth, processGroupId: birth.pid + 1 },
    { ...birth, identity: { ...birth.identity, startedAt: 'invalid birth' } },
  ]) {
    const alteredBytes = Buffer.from(JSON.stringify(changed));
    writeFileSync(`${completionPath}.command.json`, alteredBytes);
    const altered = {
      ...completion,
      commandIdentity: {
        ...completion.commandIdentity,
        sha256: createHash('sha256').update(alteredBytes).digest('hex'),
      },
    };
    assert.throws(() => readBoundPreviewCommand(record, altered), /does not belong/);
  }
  writeFileSync(`${completionPath}.command.json`, bytes);
});

test('directory identity accepts a physical alias but rejects a different or unreadable directory', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'command-directory-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const completionPath = join(root, 'completion.json');
  const command = ['missing'];
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const receipt = recordPreviewCommand({ completionPath, expiresAt, command, childPid: 123 }, () => null);
  const completion = { commandIdentity: receipt, commandGroupStatus: 'unknown' };
  const alias = join(root, 'alias');
  symlinkSync(process.cwd(), alias, 'dir');
  const record = { completionPath, pid: process.pid, expiresAt, command, cwd: alias };
  assert.equal(readBoundPreviewCommand(record, completion).sha256, receipt.sha256);
  assert.throws(() => readBoundPreviewCommand({ ...record, cwd: root }, completion), /does not belong/);
  assert.throws(() => readBoundPreviewCommand({ ...record, cwd: join(root, 'missing') }, completion));
});

test('unknown spawn/group observations stay unknown instead of becoming an absence claim', (t) => {
  assert.equal(
    observePreviewCommand(123, 45, () => ({ status: 0, stdout: 'truncated', stderr: '' })),
    null,
  );
  assert.equal(
    observePreviewCommand(123, 45, () => ({ status: 1, stdout: '', stderr: '' })),
    null,
  );
  assert.equal(
    previewCommandGroupStatus({ processGroupId: 123 }, () => {
      throw Error('timeout');
    }),
    'unknown',
  );
  assert.equal(
    previewCommandGroupStatus({ processGroupId: 123 }, () => undefined),
    'unknown',
  );
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'command-unknown-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const completionPath = join(root, 'receipt.json');
  const receipt = recordPreviewCommand(
    { completionPath, expiresAt: new Date().toISOString(), command: ['missing'], childPid: 123 },
    () => null,
  );
  assert.equal(previewCommandGroupStatus(receipt), 'unknown');
  assert.equal(JSON.parse(readFileSync(receipt.path)).identityStatus, 'unknown');
});
