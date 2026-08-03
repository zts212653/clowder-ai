import type {
  PawFeelDispositionProjection,
  PawFeelDispositionState,
  PawFeelInboxCounts,
  PawFeelInboxSort,
  PawFeelReviewBundle,
} from '@cat-cafe/shared';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
export const PAW_FEEL_OVERDUE_MS = 72 * 3_600_000;
const TERMINAL_STATES = new Set<PawFeelDispositionState>(['routed', 'closed', 'duplicate', 'no_action', 'fix']);

interface SortKey {
  sort: PawFeelInboxSort;
  terminal: number;
  time: number;
  signalId: string;
}

export function isTerminalPawFeelState(state: PawFeelDispositionState): boolean {
  return TERMINAL_STATES.has(state);
}

export function pawFeelAge(projection: PawFeelDispositionProjection, nowMs: number): number {
  const discoveredAt = Date.parse(projection.discoveredAt);
  const endAt = isTerminalPawFeelState(projection.state) ? Date.parse(projection.lastTransitionAt) : nowMs;
  return Math.max(0, endAt - discoveredAt);
}

export function emptyPawFeelInboxCounts(): PawFeelInboxCounts {
  return { total: 0, unseen: 0, inProgress: 0, routePending: 0, disposed: 0, overdue: 0 };
}

export function countPawFeelProjections(
  projections: readonly PawFeelDispositionProjection[],
  nowMs: number,
): PawFeelInboxCounts {
  const counts = emptyPawFeelInboxCounts();
  for (const projection of projections) {
    counts.total += 1;
    if (projection.state === 'new') counts.unseen += 1;
    else if (projection.state === 'seen') counts.inProgress += 1;
    else if (projection.state === 'route_pending') counts.routePending += 1;
    else counts.disposed += 1;
    if (!isTerminalPawFeelState(projection.state) && pawFeelAge(projection, nowMs) >= PAW_FEEL_OVERDUE_MS) {
      counts.overdue += 1;
    }
  }
  return counts;
}

function sortKey(projection: PawFeelDispositionProjection, sort: PawFeelInboxSort): SortKey {
  const terminal = isTerminalPawFeelState(projection.state);
  return {
    sort,
    terminal: terminal ? 1 : 0,
    time: terminal
      ? -Date.parse(projection.lastTransitionAt)
      : (sort === 'newest' ? -1 : 1) * Date.parse(projection.discoveredAt),
    signalId: projection.signalId,
  };
}

function bundleSortKey(bundle: PawFeelReviewBundle, sort: PawFeelInboxSort): SortKey {
  const first = bundle.members.map((member) => sortKey(member.disposition, sort)).sort(compareKey)[0];
  if (!first) throw new Error(`paw-feel bundle ${bundle.bundleKey} has no members`);
  return { ...first, signalId: bundle.bundleKey };
}

function compareKey(left: SortKey, right: SortKey): number {
  return left.terminal - right.terminal || left.time - right.time || left.signalId.localeCompare(right.signalId);
}

function encodeCursor(key: SortKey): string {
  return Buffer.from(JSON.stringify([key.sort, key.terminal, key.time, key.signalId])).toString('base64url');
}

function decodeCursor(cursor: string, expectedSort: PawFeelInboxSort): SortKey {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 4 ||
      (decoded[0] !== 'newest' && decoded[0] !== 'oldest') ||
      decoded[0] !== expectedSort ||
      (decoded[1] !== 0 && decoded[1] !== 1) ||
      !Number.isFinite(decoded[2]) ||
      typeof decoded[3] !== 'string'
    ) {
      throw new Error('shape');
    }
    return { sort: decoded[0], terminal: decoded[1], time: decoded[2], signalId: decoded[3] };
  } catch {
    throw new Error('invalid paw-feel inbox cursor');
  }
}

export function paginatePawFeelBundles(
  bundles: PawFeelReviewBundle[],
  query: { sort?: PawFeelInboxSort; cursor?: string; limit?: number },
): { bundles: PawFeelReviewBundle[]; nextCursor?: string } {
  const sort = query.sort ?? 'oldest';
  const cursor = query.cursor ? decodeCursor(query.cursor, sort) : undefined;
  const filtered = bundles
    .sort((left, right) => compareKey(bundleSortKey(left, sort), bundleSortKey(right, sort)))
    .filter((bundle) => !cursor || compareKey(bundleSortKey(bundle, sort), cursor) > 0);
  const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
  const page = filtered.slice(0, limit);
  const lastBundle = page.at(-1);
  return {
    bundles: page,
    ...(filtered.length > limit && lastBundle ? { nextCursor: encodeCursor(bundleSortKey(lastBundle, sort)) } : {}),
  };
}
