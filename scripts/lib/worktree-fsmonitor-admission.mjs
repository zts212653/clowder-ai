/** Bounded closed-admission native stop; recovery never touches a different inode/HEAD. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fail,
  identity,
  mustGit,
  requireIdle,
  requireNativeIdentity,
  requireSocketScope,
  withoutPids,
} from './worktree-fsmonitor-identity.mjs';
import { ADMISSION_KIND, acquireAdmission } from './worktree-fsmonitor-lifetime.mjs';
import { processRefs } from './worktree-reaper-probes.mjs';
import { requireNoUnixConsumers } from './worktree-unix-consumers.mjs';

export function gatedNativeStop(entry, scope, pid, session) {
  const guard = acquireAdmission(entry, scope, pid, session);
  const context = {
    kind: ADMISSION_KIND,
    v: 1,
    entry: { path: entry.path, head: entry.head, lifecycle: { owner: entry.lifecycle.owner } },
    gitDir: scope.gitDir,
    common: scope.common,
    identity: identity(scope.before),
    mode: scope.before.mode & 0o777,
    executable: scope.executable,
    monitorPid: pid,
    finishPid: process.pid,
    node: process.execPath,
    validator: fileURLToPath(import.meta.url),
    nonce: guard.base.nonce,
    controlPath: guard.base.controlPath,
    lockIdentity: guard.lockIdentity,
    recordPath: guard.path,
    attempt: randomUUID(),
  };
  const result = spawnSync(
    '/usr/bin/perl',
    [fileURLToPath(new URL('./worktree-fsmonitor-stop.pl', import.meta.url)), JSON.stringify(context)],
    {
      cwd: scope.gitDir,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe', guard.fd],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    },
  );
  if (result.error || result.signal || result.status !== 0 || result.stdout.trim() !== '{"stopped":true}')
    fail(
      `closed-admission native stop refused: ${String(result.stderr || result.error?.message || 'helper incomplete')
        .trim()
        .slice(0, 800)}`,
    );
}

function validateClosedAdmission(context) {
  if (context.kind !== ADMISSION_KIND || process.ppid !== context.controlPid) fail('control helper lineage unknown');
  const socket = join(context.gitDir, 'fsmonitor--daemon.ipc');
  const st = lstatSync(socket);
  const stamp = lstatSync(socket, { bigint: true }).ctimeNs.toString();
  if (identity(st) !== context.identity || (st.mode & 0o777) !== 0) fail('IPC admission not closed');
  const scope = requireSocketScope(context.entry, context.gitDir, st);
  if (
    scope.executable !== context.executable ||
    mustGit(context.entry.path, ['rev-parse', 'HEAD']) !== context.entry.head ||
    mustGit(context.entry.path, ['config', '--worktree', '--get', 'catcafe.lifecycle.owner']) !==
      context.entry.lifecycle.owner
  )
    fail('closed-admission worktree identity changed');
  // Observer children (lsof/ps) must not manufacture cwd references inside the target metadata.
  process.chdir(scope.common);
  const refs = processRefs({ excludePids: [process.pid, context.finishPid], observerPid: process.pid });
  if (!refs) fail('closed-admission process observations unknown');
  requireNativeIdentity(context.entry, context.gitDir, context.monitorPid, refs, context.executable);
  requireNoUnixConsumers(context.monitorPid, refs, { controlPid: context.controlPid });
  requireIdle(context.entry.path, context.gitDir, withoutPids(refs, [context.monitorPid, context.controlPid]));
  const final = lstatSync(socket, { bigint: true });
  if (
    identity(final) !== context.identity ||
    (final.mode & 0o777n) !== 0n ||
    final.ctimeNs.toString() !== stamp ||
    identity(lstatSync(context.recordPath)) !== context.lockIdentity
  )
    fail('closed admission changed before qualification');
  appendFileSync(
    context.recordPath,
    `${JSON.stringify({ phase: 'qualified', nonce: context.nonce, identity: context.identity, ctimeNs: stamp, attempt: context.attempt })}\n`,
  );
  const fd = openSync(context.recordPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    validateClosedAdmission(JSON.parse(process.argv[2]));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
