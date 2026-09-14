/**
 * F257 V2/Phase B — fifth friction source adapter: guard anomaly reports
 * (spec Phase B item 3 / AC-B2; F245 aggregation REUSED, no second pipeline).
 *
 * Data source: DeviationEventLog manual_observation events (V1 T-C,
 * written via report_harness_signal) whose note REFERENCES a ledger pot
 * coordinate — the ledgerId that rejection responses carry precisely so
 * cats can quote it ("撞到 4xx 锅拦截 → anomaly 上报引用 ledger id").
 *
 * Extraction is whitelist-exact: only registered GUARD_LEDGER_IDS values
 * are matched as substrings (zero false positives; unregistered refs have
 * no stats identity to attribute to). condition_hit events are system-
 * produced facts, not cat anomaly reports — excluded by design.
 *
 * KD-4 (F245): the pull path is strictly READ-ONLY — AC-B2 stats writeback
 * therefore lives on the WRITE side (report-harness-signal, at the moment
 * the anomaly report is recorded), not here. GuardLedgerStats below is the
 * shared idempotent stats surface both sides use.
 * how_counted: 'scard guard-ledger:stats:{ledgerId}:anomaly-refs —
 * distinct referencing deviation eventIds'.
 */

import type { FrictionSignal } from '@cat-cafe/shared';
import type { DeviationEvent } from '../deviation/deviation-event.js';
import { extractLedgerRefs } from '../guard-ledger-registry.js';
import type { IFrictionSignalSource } from './friction-signal-source.js';

/** Minimal query surface this adapter needs from the deviation log. */
export interface DeviationQuerySource {
  query(input: {
    ownerUserId: string;
    fromMs?: number;
    toMs?: number;
    cursor?: string;
  }): Promise<{ events: DeviationEvent[]; nextCursor: string | null }>;
}

export interface GuardAnomalyAdapterDeps {
  deviationLog: DeviationQuerySource;
  ownerUserId: string;
}

export class GuardAnomalyAdapter implements IFrictionSignalSource {
  readonly channelId = 'guard-anomaly' as const;

  constructor(private readonly deps: GuardAnomalyAdapterDeps) {}

  async pull(sinceMs: number, untilMs: number): Promise<FrictionSignal[]> {
    const signals: FrictionSignal[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.deps.deviationLog.query({
        ownerUserId: this.deps.ownerUserId,
        fromMs: sinceMs,
        // Adapter window is [since, until); deviation query toMs is inclusive.
        toMs: untilMs - 1,
        ...(cursor ? { cursor } : {}),
      });
      for (const event of page.events) {
        if (event.kind !== 'manual_observation') continue;
        for (const ledgerId of extractLedgerRefs(event.note)) {
          signals.push({
            // Deterministic id — same event+pot on every pull (idempotency contract).
            id: `guard-anomaly:${event.eventId}#${ledgerId}`,
            channel: 'guard-anomaly',
            catId: event.subjectCatId,
            threadId: event.anchors.threadId,
            timestamp: new Date(event.timestamp).toISOString(),
            symptom: `anomaly report references pot ${ledgerId}: ${event.note.slice(0, 140)}`,
            rawRef: `${event.eventId}#${ledgerId}`,
            severity: 'medium',
            sourceEvidence: event.note,
          });
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return signals;
  }
}
