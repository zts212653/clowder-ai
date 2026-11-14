import { createHmac } from 'node:crypto';
import {
  CANDIDATE_AUDIT_CANONICAL_LIMIT,
  CANDIDATE_AUDIT_MAX_ROWS,
  type CandidateRankRow,
  type CanonicalAuditOutcome,
  type CanonicalAuditRow,
  type MessageCandidateAuditRequest,
  type MessageCandidateAuditSnapshot,
  safeCandidateAudit,
  validCandidateAuditRequest,
} from './message-candidate-audit-wire.js';

interface Coordinate {
  docAnchor: string;
  passageId: string;
}

/** Reuse the explicit installation secret; never the telemetry dev/raw-ID escape hatches. */
export function ownerCandidateAuditRequest(id: string, owner: string): MessageCandidateAuditRequest | undefined {
  try {
    const salt = process.env.TELEMETRY_HMAC_SALT;
    if (!salt || Buffer.byteLength(salt) < 32) return;
    return {
      id,
      key: createHmac('sha256', salt)
        .update(JSON.stringify(['message-candidate-audit', 1, owner, id, 'message']))
        .digest('hex'),
    };
  } catch {
    return;
  }
}

/** Request-local observations of values already read. No database, provider, persistence or timers. */
export class MessageCandidateAudit {
  readonly #request: MessageCandidateAuditRequest;
  private rows: CandidateRankRow[] = [];
  private readonly indexes = new Map<string, number>();
  private readonly denied = new Set<number>();
  private readonly projected = new Set<number>();
  private canonical: CanonicalAuditRow[] = [];
  private limited = false;
  private captureMs = 0;
  private nativeState: MessageCandidateAuditSnapshot['nativeState'] = 'not_requested';
  private nativeCount: number | null = null;

  static create(request: unknown, limit: number): MessageCandidateAudit | undefined {
    if (!validCandidateAuditRequest(request) || !Number.isInteger(limit) || limit < 1 || limit > 2000) return;
    return new MessageCandidateAudit(request, limit);
  }

  private constructor(
    request: MessageCandidateAuditRequest,
    private readonly limit: number,
  ) {
    this.#request = request;
  }

  private binding() {
    return createHmac('sha256', this.#request.key)
      .update(JSON.stringify(['message-candidate-audit', 1, 'binding', this.#request.id]))
      .digest('hex')
      .slice(0, 32);
  }

  private index(row: Coordinate): number | undefined {
    if (
      typeof row.docAnchor !== 'string' ||
      typeof row.passageId !== 'string' ||
      row.docAnchor.length > 512 ||
      row.passageId.length > 512
    ) {
      this.limited = true;
      return;
    }
    const token = createHmac('sha256', this.#request.key)
      .update(JSON.stringify(['message-candidate-audit', 1, 'message', row.docAnchor, row.passageId]))
      .digest('hex')
      .slice(0, 32);
    let index = this.indexes.get(token);
    if (index === undefined) {
      if (this.rows.length >= Math.min(this.limit * 2, CANDIDATE_AUDIT_MAX_ROWS)) {
        this.limited = true;
        return;
      }
      index = this.rows.length;
      this.indexes.set(token, index);
      this.rows.push([token, 0, 0, 0, 0, 0]);
    }
    return index;
  }

  /** A hostile observer/input can only discard diagnostics, never replace search work. */
  private capture(read: () => void) {
    // A degraded native stage never regains identity authority through later lexical/host observations.
    if (this.nativeState === 'failed') return;
    const start = performance.now();
    try {
      read();
    } catch {
      this.limited = true;
    } finally {
      this.captureMs += performance.now() - start;
    }
  }

  order(stage: 1 | 3 | 4 | 5, rows: readonly Coordinate[]) {
    this.capture(() => {
      const maximum = stage === 4 ? this.limit * 2 : this.limit;
      if (rows.length > maximum) this.limited = true;
      for (let rank = 0; rank < Math.min(rows.length, maximum); rank++) {
        const index = this.index(rows[rank]);
        if (index !== undefined) this.rows[index][stage] = rank + 1;
      }
    });
  }

  nativeStarted() {
    this.nativeState = 'pending';
  }
  nativeFinished(count: number) {
    this.nativeState = 'complete';
    this.nativeCount = Math.min(count, this.limit);
    if (count > this.limit) this.limited = true;
  }
  nativeUnavailable(failed = false) {
    this.nativeState = failed ? 'failed' : 'unavailable';
    if (failed) {
      this.rows = [];
      this.indexes.clear();
      this.denied.clear();
      this.projected.clear();
      this.canonical = [];
      this.limited = true;
    }
  }

  nativeCoordinate(row: Coordinate, rank: number) {
    this.capture(() => {
      const index = this.index(row);
      if (index !== undefined && rank > 0 && rank <= this.limit) this.rows[index][2] = rank;
    });
  }

  deniedIndex(row: Coordinate) {
    this.capture(() => {
      const index = this.index(row);
      if (index !== undefined) this.denied.add(index);
    });
  }

  /** Retirement can produce two workers. Only the last successful actual reader supplies ranks. */
  adopt(value: unknown): boolean {
    const safe = safeCandidateAudit(value);
    if (!safe || safe.id !== this.#request.id || safe.scope !== this.binding() || safe.limit !== this.limit)
      return false;
    this.rows = safe.rows;
    this.indexes.clear();
    this.denied.clear();
    this.projected.clear();
    this.canonical = [];
    for (const [index, row] of this.rows.entries()) {
      if (row[0]) this.indexes.set(row[0], index);
      else this.denied.add(index);
    }
    this.nativeCount = safe.nativeCount;
    this.nativeState = safe.nativeState;
    this.captureMs = safe.captureMs;
    this.limited = safe.state === 'capture_incomplete';
    return true;
  }

  private outcome(index: number, stage: CanonicalAuditRow[1], outcome: CanonicalAuditOutcome, revision?: string) {
    if (this.canonical.length >= CANDIDATE_AUDIT_CANONICAL_LIMIT) {
      this.limited = true;
      return;
    }
    const current = revision && /^[a-f0-9]{64}$/.test(revision) ? revision : null;
    this.canonical.push([index, stage, outcome, current]);
  }

  projection(row: Coordinate, revision?: string) {
    this.capture(() => {
      const index = this.index(row);
      if (index === undefined) return;
      if (revision) this.projected.add(index);
      else this.denied.add(index);
      this.outcome(index, 'projection', revision ? 'projected' : 'owner_projection_rejected');
    });
  }

  window(rows: readonly Coordinate[]) {
    this.capture(() => {
      const admitted = new Set(rows.map((row) => this.index(row)));
      for (const index of this.projected)
        this.outcome(index, 'window', admitted.has(index) ? 'window_admitted' : 'source_filter_or_limit');
    });
  }

  final(row: Coordinate, revision?: string, expectedRevision?: string) {
    this.capture(() => {
      const index = this.index(row);
      if (index === undefined) return;
      const accepted = !!revision && revision === expectedRevision;
      if (!accepted) this.denied.add(index);
      this.outcome(
        index,
        'final',
        accepted ? 'final_admitted' : revision ? 'revision_changed' : 'owner_projection_rejected',
        accepted ? revision : undefined,
      );
    });
  }

  snapshot(): MessageCandidateAuditSnapshot | undefined {
    const rows = this.rows.map(
      (row, index): CandidateRankRow => [
        this.denied.has(index) ? null : row[0],
        row[1],
        row[2],
        row[3],
        row[4],
        row[5],
      ],
    );
    const canonical = this.canonical.map(
      (row): CanonicalAuditRow => [row[0], row[1], row[2], this.denied.has(row[0]) ? null : row[3]],
    );
    const value = {
      id: this.#request.id,
      scope: this.binding(),
      limit: this.limit,
      state: this.limited ? 'capture_incomplete' : 'complete',
      nativeState: this.nativeState,
      nativeCount: this.nativeCount,
      captureMs: this.captureMs,
      rows,
      canonical,
    };
    return (
      safeCandidateAudit(value) ??
      safeCandidateAudit({ ...value, state: 'capture_incomplete', rows: [], canonical: [] })
    );
  }
}
