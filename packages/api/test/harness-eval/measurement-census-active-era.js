// Test helper: rebuild the pre-2026-10-01 "active era" registry in a temp copy.
//
// On 2026-10-01 ten eval domains went dormant (F267 dormancy contract). The
// census tests that exercise *active* migration semantics (batch 1 = memory,
// public first migration, owner reconcile, action gates) need those domains
// active again; reviving them in a temp copy keeps those tests about their
// original invariant instead of today's registry lifecycle. Dormancy itself is
// covered by measurement-bundle-dormancy.test.js.

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { parse, stringify } from 'yaml';

// capability-tips was already disabled (gated) before the dormancy batch.
const ACTIVE_ERA_DISABLED = new Set(['eval-capability-tips.yaml']);

export function reviveActiveEraDomainFile(path) {
  const value = parse(readFileSync(path, 'utf8'));
  if (!value.dormancy) return;
  delete value.dormancy;
  value.enabled = !ACTIVE_ERA_DISABLED.has(basename(path));
  writeFileSync(path, stringify(value));
}

export function reviveActiveEraRegistry(domainDir) {
  for (const entry of readdirSync(domainDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml') || entry.name.endsWith('.metrics.yaml')) continue;
    reviveActiveEraDomainFile(resolve(domainDir, entry.name));
  }
}

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

/** Revive the registry inside a repo-shaped root and reconcile its census to match. */
export async function reviveActiveEraRepo(repoRoot) {
  const { ensureMeasurementBundleCensusFile } = await import(
    '../../dist/infrastructure/harness-eval/measurement/measurement-bundle-census-file.js'
  );
  reviveActiveEraRegistry(resolve(repoRoot, 'docs/harness-feedback/eval-domains'));
  if (existsSync(resolve(repoRoot, 'docs/harness-feedback/registry/measurement-bundles.yaml'))) {
    ensureMeasurementBundleCensusFile(repoRoot, '2026-09-30T00:00:00.000Z');
  }
}

/** Temp copy of docs/harness-feedback in the active era; caller removes `repoRoot`. */
export async function createActiveEraHarnessFeedback() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'eval-active-era-'));
  cpSync(resolve(REPO_ROOT, 'docs/harness-feedback'), resolve(repoRoot, 'docs/harness-feedback'), {
    recursive: true,
  });
  await reviveActiveEraRepo(repoRoot);
  return { repoRoot, harnessFeedbackRoot: resolve(repoRoot, 'docs/harness-feedback') };
}
