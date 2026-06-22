/**
 * F208 AC-E3: DossierDraftApplier
 *
 * Pure service that validates a distillation proposal's baseHash against the
 * current cat-dossier.md file, and applies the afterDraft content.
 *
 * Design (KD-18): "operator approve 后由持球猫 apply + commit + push"
 * This service handles the file-level operation; the calling endpoint
 * orchestrates git commit + push + store.markApplied().
 *
 * Stale-write lock (KD-17): baseHash is a SHA-256 of cat-dossier.md at
 * proposal creation time. If the file has changed since then, apply is
 * rejected — the proposal must be re-created against the new baseline.
 */

import { createHash } from 'node:crypto';
import type { DossierDistillationProposal } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApplyDraftResult {
  /** The modified file content (ready to write to disk). */
  modifiedContent: string;
  /** Relative path from repo root. */
  targetPath: string;
  /** Structured commit message. */
  commitMessage: string;
}

export interface ApplyDraftError {
  code: 'BASE_HASH_MISMATCH' | 'BEFORE_SNAPSHOT_NOT_FOUND' | 'NOT_APPROVED';
  message: string;
  /** Current file hash (for diagnostics). */
  currentHash?: string;
}

export type ApplyDraftOutcome = { ok: true; result: ApplyDraftResult } | { ok: false; error: ApplyDraftError };

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Relative path from repo root to the cat dossier file. */
export const DOSSIER_RELATIVE_PATH = 'docs/team/cat-dossier.md';

/**
 * Compute SHA-256 hex hash of file content (same algorithm used at proposal
 * creation time to fill `baseHash`).
 */
export function computeFileHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Validate and compute the modified dossier content for a given proposal.
 *
 * This is a PURE function (no I/O) — caller provides the current file content.
 * This makes it trivially testable without mocking fs/git.
 */
export function prepareDraft(proposal: DossierDistillationProposal, currentFileContent: string): ApplyDraftOutcome {
  // Gate: must be approved
  if (proposal.status !== 'approved') {
    return {
      ok: false,
      error: { code: 'NOT_APPROVED', message: `Proposal status is '${proposal.status}', expected 'approved'` },
    };
  }

  // Stale-write lock: compare baseHash with current file hash
  const currentHash = computeFileHash(currentFileContent);
  if (currentHash !== proposal.baseHash) {
    return {
      ok: false,
      error: {
        code: 'BASE_HASH_MISMATCH',
        message: `Dossier file has changed since proposal creation (expected ${proposal.baseHash.slice(0, 8)}…, got ${currentHash.slice(0, 8)}…). Re-propose against the new baseline.`,
        currentHash,
      },
    };
  }

  // Apply: replace beforeSnapshot with afterDraft ONLY within the target cat's section.
  // P1 fix: unanchored .replace() would corrupt another cat's section if the same text
  // appears earlier in the file. We locate the target section by its header pattern
  // (`cat:{catId}`) and only operate within that boundary.
  // Fail closed: if target cat section header is not found, refuse to apply rather than
  // falling back to whole-file search (which could corrupt another cat's section).
  const sectionStart = findTargetCatSectionStart(currentFileContent, proposal.targetCatId);
  if (sectionStart < 0) {
    return {
      ok: false,
      error: {
        code: 'BEFORE_SNAPSHOT_NOT_FOUND',
        message: `Target cat section header (cat:${proposal.targetCatId}) not found in dossier — cannot safely apply without section anchoring.`,
      },
    };
  }
  // Bound search to target section only (up to next ### header), not to EOF.
  // Defense-in-depth: prevents matching text in a later cat's section if proposal is malformed.
  const sectionEnd = findSectionEnd(currentFileContent, sectionStart);
  const searchScope = currentFileContent.slice(sectionStart, sectionEnd);

  if (!searchScope.includes(proposal.beforeSnapshot)) {
    return {
      ok: false,
      error: {
        code: 'BEFORE_SNAPSHOT_NOT_FOUND',
        message: `beforeSnapshot text not found in target cat section (cat:${proposal.targetCatId}) despite baseHash match — proposal may be malformed.`,
      },
    };
  }

  // Replace only the first occurrence within the target section, preserving content before it
  const offsetInScope = searchScope.indexOf(proposal.beforeSnapshot);
  const absoluteOffset = sectionStart + offsetInScope;
  const modifiedContent =
    currentFileContent.slice(0, absoluteOffset) +
    proposal.afterDraft +
    currentFileContent.slice(absoluteOffset + proposal.beforeSnapshot.length);

  // Build commit message
  const fieldsStr = proposal.targetFields.join(', ');
  const commitMessage = [
    `docs(F208): apply distillation to ${proposal.targetCatId} [${fieldsStr}]`,
    '',
    `Proposal: ${proposal.proposalId}`,
    `Source: ${proposal.sourceEvent} (${proposal.sourceId})`,
    `Rationale: ${proposal.rationale}`,
    '',
    `Approved by: ${proposal.approvedBy ?? 'unknown'}`,
    `Applied by distillation pipeline (KD-18).`,
  ].join('\n');

  return {
    ok: true,
    result: {
      modifiedContent,
      targetPath: DOSSIER_RELATIVE_PATH,
      commitMessage,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the start index of the target cat's section in the dossier file.
 * Section headers follow the pattern: ### {name} · @{handle} · `cat:{catId}`
 * Returns -1 if not found (caller must fail closed — no whole-file fallback).
 */
function findTargetCatSectionStart(content: string, targetCatId: string): number {
  // Match the heading that contains `cat:{targetCatId}`
  const pattern = new RegExp(`^###\\s+.*\`cat:${escapeRegExp(targetCatId)}\``, 'm');
  const match = pattern.exec(content);
  return match ? match.index : -1;
}

/**
 * Find where the target cat's section ends (next L3 header or EOF).
 * Used to bound search scope — prevents matching text in later sections.
 */
function findSectionEnd(content: string, sectionStart: number): number {
  // Skip past the current header line, then find next ### header
  const headerLineEnd = content.indexOf('\n', sectionStart);
  if (headerLineEnd < 0) return content.length;
  const afterHeader = content.slice(headerLineEnd + 1);
  const nextL3 = afterHeader.search(/^###\s/m);
  return nextL3 >= 0 ? headerLineEnd + 1 + nextL3 : content.length;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
