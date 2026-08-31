/**
 * Eval domain message builders — human-readable skip/status messages for
 * eval:harness-ledger and other domains.
 *
 * Extracted from eval-domain-daily.ts (file-size 350-line hard limit).
 * Each message has a stable header (`SKIPPED (...)`) for log scrubbers and
 * eval-domain readers to recognize and count programmatically.
 */

import type { EvalDomainRegistryEntry } from './eval-domain-registry.js';

// ---------------------------------------------------------------------------
// Direction B (clowder-ai#923): publish prereq skip
// ---------------------------------------------------------------------------

/**
 * Build the "publish prereq missing" status message posted to the domain's
 * own system thread when the cron skips cat invocation.
 */
export function buildPublishPrereqSkippedMessage(domain: EvalDomainRegistryEntry): string {
  return [
    `## Eval Domain: ${domain.domainId} — SKIPPED (publish prereq missing)`,
    '',
    'The scheduled eval was skipped because the runtime hosting this cron does not',
    'export the verdict-publish prerequisites required to run this eval domain end-to-end',
    '(e.g. the `isA2aSourceRefs` validator exported by `publish-verdict/validation.js`).',
    '',
    'Why this matters: invoking the eval cat without the prerequisites would let it hit',
    'an infra blocker at publish time, and (per its prompt) cross-post that blocker into',
    'a feature thread — exactly the leak [clowder-ai#923] reported. The fail-closed skip',
    'keeps the failure contained in this eval domain thread.',
    '',
    'Next action: ensure the runtime that hosts the eval cron has the publish-verdict',
    'fix landed, or pin the cron to a runtime that does (Direction A/C per the issue).',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// KD-17 snapshot-first: harness-ledger skip messages
// ---------------------------------------------------------------------------

/**
 * Build the "snapshot unavailable" skip message for eval:harness-ledger
 * when the scheduled cron cannot produce a guard rejection snapshot
 * (provider absent or snapshot production failed).
 *
 * Same pattern as `buildPublishPrereqSkippedMessage`: human-readable with
 * a stable header for log scrubbers, domain-local delivery, no cat invocation.
 */
export function buildHarnessLedgerSnapshotSkippedMessage(
  domain: EvalDomainRegistryEntry,
  reason: 'provider_not_wired' | 'snapshot_error' | 'owner_scope_missing',
  detail?: string,
): string {
  const reasonText =
    reason === 'provider_not_wired'
      ? 'GuardRejectionEventLog provider is not wired at runtime (guardRejectionLog absent in config).'
      : reason === 'owner_scope_missing'
        ? 'defaultUserId not configured — snapshot requires owner scope (sol R9 P1-2: fail-closed, never use synthetic placeholder).'
        : `Snapshot production failed: ${detail ?? 'unknown error'}.`;
  return [
    `## Eval Domain: ${domain.domainId} — SKIPPED (harness ledger snapshot unavailable)`,
    '',
    `KD-17 snapshot-first invariant: eval cat must not be invoked without`,
    `pre-computed guard rejection evidence. ${reasonText}`,
    '',
    `This is a graceful skip — the cron task itself did not error.`,
    `The eval cat was NOT invoked (no LLM cost, no blind verdict).`,
    '',
    `Next action: ensure GuardRejectionEventLog is wired and Redis is reachable`,
    `at the next scheduled fire.`,
  ].join('\n');
}

/**
 * Build the "zero events" skip message for eval:harness-ledger.
 *
 * Snapshot produced successfully but contains zero guard rejection events
 * in the observation window. Nothing to attribute → skip cat invocation
 * (LLM cost = 0). Normal during quiet periods.
 *
 * F257 eval-trigger sub-item 1: don't invoke eval cat on empty windows.
 */
export function buildHarnessLedgerZeroEventsMessage(domain: EvalDomainRegistryEntry, evalRunId: string): string {
  return [
    `## Eval Domain: ${domain.domainId} — SKIPPED (zero events in window)`,
    '',
    `KD-17 snapshot-first: snapshot produced successfully (evalRunId: \`${evalRunId}\`)`,
    'but contains zero guard rejection events in the observation window.',
    '',
    'No attribution analysis needed — eval cat NOT invoked (LLM cost = 0).',
    'This is normal during quiet periods (baseline accumulation).',
    '',
    'The weekly cron will re-check at the next scheduled fire.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Publish prereq evaluation helper
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the runtime satisfies the publish-verdict prerequisites
 * for a given eval domain. Fail-closed: a probe that throws is treated as
 * "prereq missing" (better to skip than to leak).
 */
export async function evaluatePublishPrereq(
  probe: (domainId: EvalDomainRegistryEntry['domainId']) => boolean | Promise<boolean>,
  domainId: EvalDomainRegistryEntry['domainId'],
): Promise<boolean> {
  try {
    return await Promise.resolve(probe(domainId));
  } catch {
    return false;
  }
}
