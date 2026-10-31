import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateTerminalResult, deriveGateRoute } from '../classify-gate-route.mjs';
import { markGateStageGreen } from './gate-stage-receipts.mjs';
import { beginGateRun, settleGateRun } from './gate-terminal-receipt.mjs';

export const INPUT = 'docs/evidence/fixtures/input.md';
export const REPORT = 'docs/evidence/report.png';
const JS = "import {readFileSync} from 'node:fs'; import {resolve} from 'node:path'; const repo=process.cwd(); ";
export const READERS = [
  [
    'segment spread',
    'reader.mjs',
    JS +
      'const parts=["docs","evidence","fixtures","input.md"]; console.log(readFileSync(resolve(repo,...parts),"utf8"));',
    process.execPath,
  ],
  [
    'array join',
    'reader.mjs',
    JS +
      'const rel=["docs","evidence","fixtures","input.md"].join("/"); console.log(readFileSync(resolve(repo,rel),"utf8"));',
    process.execPath,
  ],
  [
    'directory binding',
    'reader.mjs',
    JS +
      'const root=resolve(repo,"docs","evidence"); console.log(readFileSync(resolve(root,"fixtures","input.md"),"utf8"));',
    process.execPath,
  ],
  [
    'Python path segments',
    'reader.py',
    'from pathlib import Path\nparts=["docs","evidence","fixtures","input.md"]\nprint(Path.cwd().joinpath(*parts).read_text())\n',
    'python3',
  ],
];

export function fixture(t, { reader = READERS[0], status = 'green', route = 'full' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gate-c2-claim-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), value);
  };
  const commit = (message) => {
    git('add', '.');
    git('commit', '-qm', message);
  };
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', root);
  git('config', 'user.name', 'Gate Test');
  git('config', 'user.email', 'gate@example.test');
  write('package.json', '{"packageManager":"pnpm@9.15.4"}\n');
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  write('packages/shared/contract.ts', 'export const value = 1;\n');
  write(INPUT, 'consumed input');
  write(REPORT, 'unconsumed report');
  write(reader[1], reader[2]);
  commit('base');
  const oldBase = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'candidate');
  write('packages/shared/contract.ts', 'export const value = 2;\n');
  commit('authored shared patch');
  assert.equal(execFileSync(reader[3], [reader[1]], { cwd: root, encoding: 'utf8' }).trim(), 'consumed input');
  const databasePath = path.join(root, '.git', 'gate.sqlite');
  const first = deriveGateRoute({ repoRoot: root, databasePath, baseSha: oldBase });
  assert.equal(first.route, 'full');
  const ownerIdentity = { pid: process.pid, startedAt: 'fixture-owner' };
  const run = beginGateRun({ databasePath, fingerprint: first.fingerprint, ownerIdentity, jobId: 'full-fixture' });
  markGateStageGreen({
    databasePath,
    runId: run.runId,
    stage: 'tsc',
    ownerIdentity,
    expectedFingerprint: first.fingerprint,
  });
  settleGateRun({
    databasePath,
    runId: run.runId,
    status,
    requiredStages: ['tsc'],
    result: createGateTerminalResult({ routeEvidence: { ...first, route }, status }),
  });
  const advance = (change = () => write(REPORT, 'updated report')) => {
    git('checkout', '-q', 'main');
    change();
    commit('upstream change');
    const baseSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'candidate');
    git('rebase', 'main');
    return baseSha;
  };
  const args = (baseSha, inertPaths = [REPORT]) => ({
    repoRoot: root,
    databasePath,
    runId: run.runId,
    baseSha,
    assertion: {
      actor: 'gate-owner-test',
      sourceRef: 'thread_fixture#C2',
      rationale: 'reviewed delivery-only exact paths',
      inertPaths,
    },
  });
  return { root, git, write, commit, databasePath, first, ownerIdentity, run, advance, args };
}
