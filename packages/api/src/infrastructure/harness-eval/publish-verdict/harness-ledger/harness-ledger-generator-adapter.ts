/**
 * F257 Eval Engine Wiring — harness-ledger generator adapter.
 *
 * KD-17 snapshot-first pattern: reads a pre-produced run snapshot
 * (written by trigger via harness-ledger-snapshot-provider) instead
 * of querying GuardRejectionEventLog directly. Single-read by
 * evalRunId — decision and artifact share one data source.
 *
 * Flow:
 *   1. Discriminator: sourceRefs.kind === 'prompt-segments'
 *   2. Validate window (start < end, both finite)
 *   3. Read stored run snapshot by evalRunId (fail-closed on missing)
 *   4. Write verdict markdown + bundle artifacts from snapshot data
 *   5. Return paths
 *
 * Fail-closed: missing snapshot file → 500 (not false verdict).
 * The snapshot was produced by queryWindowStrict in the provider —
 * Redis errors already surfaced at trigger time.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessLedgerRunSnapshot } from '../../harness-ledger-snapshot-provider.js';
import type { PromptSegmentsSourceSelector, VerdictGenerator } from '../types.js';
import { buildAttribution, buildByGuardEpisodes, buildVerdictMarkdown } from './harness-ledger-verdict-builders.js';

/**
 * Creates the eval:harness-ledger verdict generator.
 *
 * No longer takes GuardRejectionEventLog — data access moved to the
 * snapshot provider (trigger-time, not publish-time). Generator reads
 * the stored snapshot from liveHarnessFeedbackRoot/run-snapshots/.
 */
export function createHarnessLedgerGeneratorAdapter(): VerdictGenerator {
  return async (packet, sourceRefs, deps) => {
    // Step 1: discriminator check
    const kind = (sourceRefs as { kind?: string }).kind;
    if (kind !== 'prompt-segments') {
      throw new Error(
        `harness_ledger_adapter_wrong_kind: received sourceRefs with kind='${kind ?? '(omitted)'}'; expected 'prompt-segments'`,
      );
    }

    const selector = sourceRefs as unknown as PromptSegmentsSourceSelector;

    // Step 2: validate window
    if (!Number.isFinite(selector.windowStartMs) || !Number.isFinite(selector.windowEndMs)) {
      throw new Error('invalid_window: windowStartMs and windowEndMs must be finite numbers');
    }
    if (selector.windowEndMs <= selector.windowStartMs) {
      throw new Error('invalid_window: windowEndMs must be greater than windowStartMs');
    }

    // Step 3: read stored run snapshot (KD-17 single-read).
    // evalRunId is REQUIRED — trigger must produce snapshot before eval cat publishes.
    const evalRunId = selector.evalRunId;
    if (!evalRunId) {
      throw new Error(
        'harness_ledger_adapter_missing_run_id: sourceRefs.evalRunId is required. ' +
          'Trigger must call produceHarnessLedgerRunSnapshot before eval cat invocation (KD-17).',
      );
    }
    // Path-safety: evalRunId format is validated at MCP + validation layers,
    // but defense-in-depth here prevents path traversal even if upstream skips.
    if (!/^hlr-\d+-[a-f0-9]{8}$/.test(evalRunId)) {
      throw new Error(
        `harness_ledger_adapter_invalid_run_id: evalRunId '${evalRunId}' does not match safe format hlr-<ts>-<hex8>.`,
      );
    }
    const snapshotFilePath = join(deps.liveHarnessFeedbackRoot, 'run-snapshots', `${evalRunId}.json`);
    if (!existsSync(snapshotFilePath)) {
      throw new Error(
        `harness_ledger_adapter_snapshot_missing: ${snapshotFilePath} not found. ` +
          'Run snapshot may have been cleaned up or trigger failed to produce it (fail-closed KD-17).',
      );
    }
    const storedSnapshot = JSON.parse(readFileSync(snapshotFilePath, 'utf8')) as HarnessLedgerRunSnapshot;

    // sol R10 P1-1: owner-scope validation — generator must NOT produce artifacts
    // from a snapshot belonging to a different owner. Fail-closed on all three
    // states: deps missing owner, snapshot missing owner, mismatch.
    if (!deps.ownerUserId) {
      throw new Error(
        'harness_ledger_adapter_owner_missing: deps.ownerUserId is required. ' +
          'Generator must run with server-injected owner scope (fail-closed).',
      );
    }
    if (!storedSnapshot.ownerUserId) {
      throw new Error(
        'harness_ledger_adapter_snapshot_owner_missing: stored snapshot lacks ownerUserId. ' +
          'Snapshot may predate owner-scope enforcement — re-trigger to produce a scoped snapshot.',
      );
    }
    if (deps.ownerUserId !== storedSnapshot.ownerUserId) {
      throw new Error(
        'harness_ledger_adapter_owner_mismatch: deps.ownerUserId does not match stored snapshot owner. ' +
          'Cross-owner artifact production is forbidden (fail-closed).',
      );
    }

    // KD-17 single-source: verify selector window matches stored snapshot window.
    // Prevents drift where cat claims different window than what snapshot actually covers.
    if (
      selector.windowStartMs !== storedSnapshot.window.startMs ||
      selector.windowEndMs !== storedSnapshot.window.endMs
    ) {
      throw new Error(
        `harness_ledger_adapter_window_mismatch: selector window [${selector.windowStartMs}, ${selector.windowEndMs}) ` +
          `does not match stored snapshot window [${storedSnapshot.window.startMs}, ${storedSnapshot.window.endMs}). ` +
          'KD-17 invariant: decision and artifact must share the same data source.',
      );
    }

    // Extract aggregates from stored snapshot (no re-query).
    const { totalEvents, byKind, byGuard } = storedSnapshot;
    const hasEvents = totalEvents > 0;

    const generatedAt = new Date().toISOString();
    const evalSnapshotId = `harness-ledger-snapshot-${packet.id}`;
    const windowMs = selector.windowEndMs - selector.windowStartMs;
    const windowHours = Math.round(windowMs / (3600 * 1000));
    const windowDays = Math.round(windowMs / (24 * 3600 * 1000));

    // Step 4: write bundle artifacts
    const verdictPath = join(deps.harnessFeedbackRoot, 'verdicts', `${packet.id}.md`);
    const bundleDir = join(deps.harnessFeedbackRoot, 'bundles', packet.id);
    mkdirSync(join(deps.harnessFeedbackRoot, 'verdicts'), { recursive: true });
    mkdirSync(bundleDir, { recursive: true });

    // Flatten byGuard for snapshot.json frictionCounts (count-only map).
    const guardCountMap: Record<string, number> = {};
    for (const [gid, agg] of Object.entries(byGuard)) {
      guardCountMap[gid] = agg.count;
    }

    const byGuardEpisodes = buildByGuardEpisodes(byGuard);

    // --- Bundle: snapshot.json ---
    const bundleSnapshot = {
      verdictId: packet.id,
      evalSnapshotId,
      featureId: 'F257',
      generatedAt,
      window: { startMs: selector.windowStartMs, endMs: selector.windowEndMs, durationHours: windowHours },
      totalEvents,
      byKind,
      byGuard: guardCountMap,
      byGuardEpisodes,
      sampleAnchors: storedSnapshot.sampleAnchors ?? [],
      // sol R2 P2: truncation must survive into the COMMITTED bundle — a
      // capped window means every count is a lower bound, and the verdict's
      // evidence chain has to say so. Confidence degrades accordingly.
      truncated: storedSnapshot.truncated ?? false,
      // Sol R1 P2-1: reason breakdown from stored snapshot — self-documents
      // which skip reasons contributed (e.g. "all 3 were dedup_active").
      ...(storedSnapshot.byReason ? { byReason: storedSnapshot.byReason } : {}),
      components: [
        {
          componentId: 'guard-rejection-log',
          componentName: 'Guard Rejection Event Log',
          activationCounts: { total_events: totalEvents, ...byKind },
          frictionCounts: guardCountMap,
          confidence: (storedSnapshot.truncated ?? false) ? 'low' : hasEvents ? 'medium' : 'no-data',
        },
      ],
    };
    const snapshotJson = JSON.stringify(bundleSnapshot, null, 2);
    writeFileSync(join(bundleDir, 'snapshot.json'), snapshotJson);

    // --- Bundle: attribution.json ---
    const attribution = buildAttribution({
      verdictId: packet.id,
      featureId: 'F257',
      evalSnapshotId,
      generatedAt,
      hasEvents,
      byGuard,
      windowDays,
      windowStartMs: selector.windowStartMs,
      windowEndMs: selector.windowEndMs,
    });
    writeFileSync(join(bundleDir, 'attribution.json'), JSON.stringify(attribution, null, 2));

    // --- Bundle: provenance.json ---
    const snapshotSha = createHash('sha256').update(snapshotJson).digest('hex');
    const provenance = {
      verdictId: packet.id,
      rawInputs: [{ path: `bundles/${packet.id}/snapshot.json`, sha256: snapshotSha }],
      generatedAt,
      generator: { name: 'harness-ledger-generator-adapter', version: '2.0.0' },
      sanitizeRulesVersion: '1.0.0',
      // KD-17 provenance: link back to the run snapshot that fed this bundle.
      // Sol R1 P2-1: sourceThreadId from stored snapshot (server-injected, not self-reported).
      producedBy: {
        runId: evalRunId,
        ...(storedSnapshot.sourceThreadId ? { sourceThreadId: storedSnapshot.sourceThreadId } : {}),
        // Sol R4 P1-1 / Fable ruling: escalation kind provenance.
        // Eval cat sees whether this was a confirmed harmful escalation
        // or an uncertainty probe (truncation-only, capped scan).
        ...(storedSnapshot.escalationKind ? { escalationKind: storedSnapshot.escalationKind } : {}),
      },
    };
    writeFileSync(join(bundleDir, 'provenance.json'), JSON.stringify(provenance, null, 2));

    // --- Verdict markdown ---
    const verdictMd = buildVerdictMarkdown({
      packet,
      bundleSnapshot,
      evalSnapshotId,
      hasEvents,
      byKind,
      guardCountMap,
      windowDays,
      totalEvents,
    });
    writeFileSync(verdictPath, verdictMd);

    return { verdictPath, bundleDir };
  };
}
