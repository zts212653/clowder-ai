/**
 * F231 Phase C Task2: per-cat primer write + provenance (KD-12/KD-15).
 *
 * P1-1 (codex review): the two file side-effects are SPLIT into separate functions so the
 * decision route can checkpoint `writtenPath` AFTER the primer write but BEFORE provenance
 * starts. A single combined call left an unrecoverable window — if provenance failed or the
 * process died between writes, the route never persisted that the primer had already changed,
 * and retry hit a stale-hash mismatch. Now: writeProfilePrimer → route.recordCheckpoint(writtenPath)
 * → writeProfileProvenance → route.recordCheckpoint(provenancePath) → finalize. Crash recovery
 * reads the checkpoint and skips the already-done step (no primer re-hash, no provenance dup).
 *
 * P1-2 (codex review): targetPath is validated as profile-dir-relative `relationship/{catId}-primer.md`
 * — no absolute paths, no `..` escape.
 *
 * P1-2 optimistic lock: writeProfilePrimer re-reads the current primer and compares its hash to the
 * proposal's `baseContentHash`. The CALLER (decision route) MUST hold the per-target lock so this
 * re-read→compare→write is atomic against concurrent same-primer approves.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { ProfileUpdateProposal } from '@cat-cafe/shared';

export class StaleProfileUpdateError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`primer changed since propose (P1-2 optimistic lock): expected ${expected}, got ${actual}`);
    this.name = 'StaleProfileUpdateError';
  }
}

export class InvalidPrimerPathError extends Error {
  constructor(message: string) {
    super(`invalid primer targetPath (P1-2): ${message}`);
    this.name = 'InvalidPrimerPathError';
  }
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** The proposal fields the writers need (subset of ProfileUpdateProposal). */
export type WritableProfileUpdate = Pick<
  ProfileUpdateProposal,
  | 'proposalId'
  | 'sourceCatId'
  | 'sourceThreadId'
  | 'targetPath'
  | 'afterContent'
  | 'baseContentHash'
  | 'beforeContent'
  | 'rationale'
  | 'signalProvenance'
>;

export type ProfileWriteFileOps = Pick<typeof import('node:fs'), 'writeFileSync' | 'renameSync' | 'rmSync'>;

export interface WriteProfilePrimerOptions {
  /**
   * Crash recovery only: proposal is already `approving` and the primer may have been written
   * before `writtenPath` was checkpointed. Pending proposals must not use this shortcut because it
   * would bypass the optimistic lock for independent proposals with identical afterContent.
   */
  allowAlreadyApplied?: boolean;
  fileOps?: ProfileWriteFileOps;
}

const DEFAULT_FILE_OPS: ProfileWriteFileOps = { writeFileSync, renameSync, rmSync };

/**
 * P1-2: resolve + validate the per-cat primer path. AC-C1 enforces exactly
 * `relationship/{catId}-primer.md`, profile-dir-relative, no `..`/absolute escape.
 */
export function resolvePrimerPath(profileDir: string, targetPath: string, catId: string): string {
  const expected = join('relationship', `${catId}-primer.md`);
  if (targetPath !== expected) {
    throw new InvalidPrimerPathError(`targetPath must be "${expected}", got "${targetPath}"`);
  }
  const base = resolve(profileDir);
  const full = resolve(base, targetPath);
  const rel = relative(base, full);
  if (rel.startsWith('..') || resolve(base, rel) !== full || full === base) {
    throw new InvalidPrimerPathError(`targetPath escapes profileDir: "${targetPath}"`);
  }
  return full;
}

/** Deterministic provenance path (proposalId-based → retry overwrites same file, no dup). */
export function provenancePathFor(profileDir: string, proposal: WritableProfileUpdate): string {
  return join(profileDir, 'provenance', `${proposal.proposalId}-${proposal.sourceCatId}-primer.md`);
}

/**
 * P1-1 step 1: re-read current primer, optimistic-lock check, write afterContent.
 * Returns the writtenPath; the route checkpoints it BEFORE calling writeProfileProvenance.
 */
export function writeProfilePrimer(
  proposal: WritableProfileUpdate,
  profileDir: string,
  options: WriteProfilePrimerOptions = {},
): { writtenPath: string } {
  const fileOps = options.fileOps ?? DEFAULT_FILE_OPS;
  const primerPath = resolvePrimerPath(profileDir, proposal.targetPath, proposal.sourceCatId);
  const current = existsSync(primerPath) ? readFileSync(primerPath, 'utf8') : '';
  const currentHash = hashContent(current);
  if (currentHash !== proposal.baseContentHash) {
    if (options.allowAlreadyApplied && current === proposal.afterContent) return { writtenPath: primerPath };
    throw new StaleProfileUpdateError(proposal.baseContentHash, currentHash);
  }
  mkdirSync(dirname(primerPath), { recursive: true });
  atomicWriteUtf8(primerPath, proposal.afterContent, fileOps);
  return { writtenPath: primerPath };
}

/**
 * P1-1 step 2: write deterministic-path provenance. Uses `proposal.beforeContent` (pinned at
 * propose), NOT the current primer — so crash recovery (primer already overwritten) still
 * records the correct before/after. Idempotent: same proposalId overwrites the same file.
 */
export function writeProfileProvenance(
  proposal: WritableProfileUpdate,
  profileDir: string,
): { provenancePath: string } {
  const provenancePath = provenancePathFor(profileDir, proposal);
  mkdirSync(dirname(provenancePath), { recursive: true });
  writeFileSync(provenancePath, renderProvenance(proposal), 'utf8');
  return { provenancePath };
}

function renderProvenance(proposal: WritableProfileUpdate): string {
  return [
    `# Provenance: profile-update ${proposal.proposalId}`,
    '',
    `- cat: ${proposal.sourceCatId}`,
    `- target: ${proposal.targetPath}`,
    `- thread: ${proposal.sourceThreadId}`,
    `- rationale: ${proposal.rationale}`,
    `- signalKind: ${proposal.signalProvenance.kind}`,
    `- signalSourceThread: ${proposal.signalProvenance.sourceThreadId}`,
    ...(proposal.signalProvenance.sourceMessageId
      ? [`- signalSourceMessage: ${proposal.signalProvenance.sourceMessageId}`]
      : []),
    '',
    '## Before (pinned at propose)',
    '',
    proposal.beforeContent,
    '',
    '## After',
    '',
    proposal.afterContent,
    '',
  ].join('\n');
}

function atomicWriteUtf8(path: string, content: string, fileOps: ProfileWriteFileOps): void {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fileOps.writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'wx' });
    fileOps.renameSync(tmpPath, path);
  } catch (err) {
    try {
      fileOps.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only; preserving the existing primer is the invariant.
    }
    throw err;
  }
}
