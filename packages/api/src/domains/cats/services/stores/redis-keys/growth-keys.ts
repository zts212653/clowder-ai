/**
 * Redis key patterns for cat journey footfall counters — F160.
 * Key: journey:{catId}:{dimension}  → total XP (INCRBY, no TTL — lifetime stat)
 * Key: journey:audit:{catId}        → sorted set of XP events (score = timestamp)
 */

/** Persistent XP counter per cat per dimension. */
export function growthXpKey(catId: string, dimension: string): string {
  return `journey:${catId}:${dimension}`;
}

/** Sorted set holding XP event audit trail for one cat. Score = epoch ms. */
export function growthAuditKey(catId: string): string {
  return `journey:audit:${catId}`;
}

/** SCAN pattern to match all journey keys for one cat. */
export function growthCatScan(catId: string): string {
  return `journey:${catId}:*`;
}

/** SCAN pattern to match all journey keys. */
export const GROWTH_SCAN_ALL = 'journey:*';

// ── Phase B: Title + Bond keys ─────────────────────────────────────

/** Sorted set of unlocked titles for one cat. Score = unlock timestamp, member = title JSON. */
export function growthTitleKey(catId: string): string {
  return `journey:titles:${catId}`;
}

/** Bond score between two cats. Key is always sorted (catA < catB) to ensure uniqueness. */
export function growthBondKey(catA: string, catB: string): string {
  const [a, b] = catA < catB ? [catA, catB] : [catB, catA];
  return `journey:bond:${a}:${b}`;
}

/** SCAN pattern to match all bond keys for one cat. */
export function growthBondScan(catId: string): string {
  return `journey:bond:*${catId}*`;
}

// ── Phase D: Leadership keys (铲屎官六维) ────────────────────────

/** Persistent XP counter per leadership dimension. */
export function leadershipXpKey(dimension: string): string {
  return `leadership:${dimension}`;
}

/** Sorted set holding leadership XP audit trail. Score = epoch ms. */
export function leadershipAuditKey(): string {
  return 'leadership:audit';
}

/** Sorted set of unlocked leadership titles. Score = unlock timestamp, member = JSON. */
export function leadershipTitleKey(): string {
  return 'leadership:titles';
}

/** SCAN pattern to match all leadership keys. */
export const LEADERSHIP_SCAN_ALL = 'leadership:*';

// ── Phase E: Evolution event keys ────────────────────────────────

/** Sorted set holding evolution events for one cat. Score = epoch ms. */
export function evolutionEventKey(catId: string): string {
  return `evolution:${catId}`;
}
