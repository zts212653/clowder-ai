/** Internal, content-free evidence. Never a public search response or authority proof. */
export interface MessageCandidateAuditRequest {
  id: string;
  key: string;
}

/** fingerprint, lexical rank, original NN rank, filtered NN input rank, pre-limit fusion rank, reader rank. */
export type CandidateRankRow = [string | null, number, number, number, number, number];
export type CanonicalAuditOutcome =
  | 'projected'
  | 'owner_projection_rejected'
  | 'window_admitted'
  | 'source_filter_or_limit'
  | 'final_admitted'
  | 'revision_changed';
export type CanonicalAuditRow = [number, 'projection' | 'window' | 'final', CanonicalAuditOutcome, string | null];

export interface MessageCandidateAuditSnapshot {
  id: string;
  scope: string;
  limit: number;
  rowLimit: number;
  canonicalLimit: number;
  state: 'complete' | 'capture_incomplete';
  nativeState: 'not_requested' | 'pending' | 'complete' | 'unavailable' | 'failed';
  nativeCount: number | null;
  captureMs: number;
  rows: CandidateRankRow[];
  canonical: CanonicalAuditRow[];
}

export const CANDIDATE_AUDIT_MAX_BYTES = 384 * 1024;
export const CANDIDATE_AUDIT_MAX_ROWS = 4000;
export const CANDIDATE_AUDIT_CANONICAL_LIMIT = 2000 + 32 * 2;
export const auditIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function validCandidateAuditRequest(value: unknown): value is MessageCandidateAuditRequest {
  try {
    if (!value || typeof value !== 'object') return false;
    const input = value as Record<string, unknown>;
    return (
      typeof input.id === 'string' &&
      auditIdPattern.test(input.id) &&
      typeof input.key === 'string' &&
      /^[a-f0-9]{64}$/i.test(input.key)
    );
  } catch {
    return false;
  }
}

const boundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum;
const digest = (value: unknown, width: number): value is string =>
  typeof value === 'string' && value.length === width && /^[a-f0-9]+$/.test(value);

function validHeader(input: MessageCandidateAuditSnapshot): boolean {
  return (
    typeof input.id === 'string' &&
    auditIdPattern.test(input.id) &&
    boundedInteger(input.limit, 2000) &&
    input.limit > 0 &&
    digest(input.scope, 32) &&
    ['complete', 'capture_incomplete'].includes(input.state) &&
    ['not_requested', 'pending', 'complete', 'unavailable', 'failed'].includes(input.nativeState) &&
    (input.nativeCount === null || boundedInteger(input.nativeCount, input.limit)) &&
    Number.isFinite(input.captureMs) &&
    input.captureMs >= 0
  );
}

function safeRankRows(input: MessageCandidateAuditSnapshot): CandidateRankRow[] | undefined {
  if (!Array.isArray(input.rows) || input.rows.length > Math.min(input.limit * 2, CANDIDATE_AUDIT_MAX_ROWS)) return;
  const rows: CandidateRankRow[] = [];
  for (const row of input.rows) {
    if (!Array.isArray(row) || row.length !== 6) return;
    if (row[0] !== null && !digest(row[0], 32)) return;
    if (row.slice(1).some((rank, index) => !boundedInteger(rank, index === 3 ? input.limit * 2 : input.limit))) return;
    rows.push([row[0], row[1], row[2], row[3], row[4], row[5]]);
  }
  return rows;
}

function safeCanonicalRows(
  input: MessageCandidateAuditSnapshot,
  rows: CandidateRankRow[],
): CanonicalAuditRow[] | undefined {
  if (!Array.isArray(input.canonical) || input.canonical.length > CANDIDATE_AUDIT_CANONICAL_LIMIT) return;
  const canonical: CanonicalAuditRow[] = [];
  for (const row of input.canonical) {
    if (!Array.isArray(row) || row.length !== 4 || !boundedInteger(row[0], rows.length - 1)) return;
    const allowed = {
      projection: ['projected', 'owner_projection_rejected'],
      window: ['window_admitted', 'source_filter_or_limit'],
      final: ['final_admitted', 'revision_changed', 'owner_projection_rejected'],
    };
    if (!Object.hasOwn(allowed, row[1]) || !allowed[row[1]].includes(row[2])) return;
    if (
      row[3] !== null &&
      (row[1] !== 'final' || row[2] !== 'final_admitted' || !rows[row[0]][0] || !digest(row[3], 64))
    )
      return;
    canonical.push([row[0], row[1], row[2], row[3]]);
  }
  return canonical;
}

/** Whitelist, bound and detach IPC/observer data before it can enter any trace or error. */
export function safeCandidateAudit(value: unknown): MessageCandidateAuditSnapshot | undefined {
  try {
    if (!value || typeof value !== 'object') return;
    const input = value as MessageCandidateAuditSnapshot;
    if (!validHeader(input)) return;
    // A vector failure can precede admission of native-only hits. Even an older producer
    // must not pass those identities into the host; retain only bounded aggregate evidence.
    const rows = input.nativeState === 'failed' ? [] : safeRankRows(input);
    if (!rows) return;
    const canonical = input.nativeState === 'failed' ? [] : safeCanonicalRows(input, rows);
    if (!canonical) return;
    const safe: MessageCandidateAuditSnapshot = {
      id: input.id,
      scope: input.scope,
      limit: input.limit,
      rowLimit: Math.min(input.limit * 2, CANDIDATE_AUDIT_MAX_ROWS),
      canonicalLimit: CANDIDATE_AUDIT_CANONICAL_LIMIT,
      state: input.nativeState === 'failed' ? 'capture_incomplete' : input.state,
      nativeState: input.nativeState,
      nativeCount: input.nativeCount,
      captureMs: input.captureMs,
      rows,
      canonical,
    };
    if (Buffer.byteLength(JSON.stringify(safe)) > CANDIDATE_AUDIT_MAX_BYTES) return;
    return safe;
  } catch {
    return;
  }
}
