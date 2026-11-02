import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChecksPassed, collectChecks } from './checks.mjs';

export function candidateRoot(root, runnerTemp) {
  assert.ok(root && runnerTemp, 'Candidate root and runner temporary directory are required');
  const resolved = path.resolve(root);
  const normalizeCase = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  assert.equal(normalizeCase(path.dirname(resolved)), normalizeCase(path.resolve(runnerTemp)));
  assert.match(path.basename(resolved), /^f330-candidate-[A-Za-z0-9_-]+$/);
  return resolved;
}

export function cleanupConfirmed(receipt, kind, attemptId) {
  return (
    receipt?.distribution === kind &&
    receipt.attemptId === attemptId &&
    typeof attemptId === 'string' &&
    receipt.ownedProcessesAbsent === true &&
    receipt.portsFree === true
  );
}

export async function verifyDistributions(root, execute) {
  const evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const output = path.join(evidence, 'distribution-results.json');
  const attempts = new Map();
  const project = (checks) => checks.map((check) => ({ ...check, attemptId: attempts.get(check.name) }));
  const result = await collectChecks(
    ['installer', 'portable'],
    async (kind) => {
      const attemptId = randomUUID();
      attempts.set(kind, attemptId);
      await execute(kind, attemptId);
      const receipt = JSON.parse(fs.readFileSync(path.join(evidence, kind, 'result.json'), 'utf8'));
      assert.equal(receipt.distribution, kind);
      assert.equal(receipt.attemptId, attemptId);
      assert.equal(receipt.status, 'passed');
    },
    {
      canContinue: async (kind) => {
        try {
          return cleanupConfirmed(
            JSON.parse(fs.readFileSync(path.join(evidence, kind, 'cleanup-confirmed.json'), 'utf8')),
            kind,
            attempts.get(kind),
          );
        } catch {
          return false;
        }
      },
      observe: (checks) =>
        fs.writeFileSync(output, JSON.stringify({ status: 'in_progress', checks: project(checks) }, null, 2)),
    },
  );
  fs.writeFileSync(output, JSON.stringify({ status: result.status, checks: project(result.checks) }, null, 2));
  assertChecksPassed(result);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = candidateRoot(process.env.CANDIDATE_ROOT, process.env.RUNNER_TEMP);
  await verifyDistributions(root, async (kind, attemptId) => {
    const script = fileURLToPath(new URL('./windows.ps1', import.meta.url));
    const child = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', script, '-Distribution', kind, '-AttemptId', attemptId],
      {
        stdio: 'inherit',
        shell: false,
      },
    );
    if (child.error) throw child.error;
    assert.equal(child.status, 0, `Native ${kind} verification failed`);
  });
}
