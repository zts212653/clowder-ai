'use client';

/**
 * Seam for the rail's world list (F290 authoritative directory, #4830 adapter).
 *
 * `useCollectiveWorldDirectory` subscribes through ONE Collective iframe bridge (single Service, exact iframe),
 * and that iframe only exists on the /collective surface. The app-level rail has no directory of its own and must
 * not open a second handshake, copy authority, or invent world names. So outside that surface the directory is
 * reported as UNKNOWN — never as an empty list — and the rail shows the existing Collective destination.
 *
 * When F290 exposes a shared, read-only directory projection + selectWorld (their single-writer slice), only this
 * hook changes: it starts returning `ready` worlds (with the "…" overflow list) and the real failure states
 * (读取中 / 服务连不上 / 需要重新登录 / 当前账号没有访问资格).
 */
export type WorldRailDirectory = { status: 'unknown'; statusText: string; worlds: readonly [] };

const UNKNOWN_DIRECTORY: WorldRailDirectory = {
  status: 'unknown',
  statusText: '打开后查看各个世界',
  worlds: [],
};

export function useWorldRailEntries(): WorldRailDirectory {
  return UNKNOWN_DIRECTORY;
}
