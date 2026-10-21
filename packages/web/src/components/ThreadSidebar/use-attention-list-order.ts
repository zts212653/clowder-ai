import type { ThreadAttentionMemberSort } from '@cat-cafe/shared';
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShellPresentation } from '../shell/shell-presentation';
import {
  type AttentionCluster,
  type AttentionListRow,
  type AttentionRenderItem,
  flattenAttentionRows,
} from './attention-clusters';
import { type AttentionOrderSnapshot, orderAttentionList } from './attention-list-order';

/** Shared by flat, project and virtual lists; virtualization cannot unmount the reading session. */
export function useAttentionListOrder(
  lists: Readonly<Record<string, AttentionRenderItem[]>>,
  isOpen: (cluster: AttentionCluster) => boolean,
  modes: Readonly<Record<string, ThreadAttentionMemberSort>>,
  scope: string,
  query: string,
  arranging: boolean,
  pointerHeld?: boolean,
): Record<string, AttentionListRow[]> {
  const v2Ordering = useShellPresentation() === 'v2' && !arranging;
  const committed = useRef<{
    scope: string;
    v2Ordering: boolean;
    snapshots: Record<string, AttentionOrderSnapshot>;
  }>();
  const { snapshots, rows } = useMemo(() => {
    // v2 refreshes while the pointer is outside; the reading snapshot protects current click targets inside.
    const previous =
      committed.current?.scope === scope &&
      committed.current.v2Ordering === v2Ordering &&
      (pointerHeld === undefined || !v2Ordering || pointerHeld)
        ? committed.current.snapshots
        : {};
    const snapshots: Record<string, AttentionOrderSnapshot> = {};
    const rows: Record<string, AttentionListRow[]> = {};
    for (const [key, items] of Object.entries(lists)) {
      const result = orderAttentionList(
        items,
        isOpen,
        arranging ? {} : modes,
        arranging ? undefined : previous[key],
        v2Ordering,
        v2Ordering && pointerHeld === true,
      );
      snapshots[key] = result.snapshot;
      rows[key] = flattenAttentionRows(result.items, isOpen, query);
    }
    return { snapshots, rows };
  }, [lists, isOpen, modes, scope, query, arranging, v2Ordering, pointerHeld]);
  // An abandoned concurrent render must not become a remembered user-visible order.
  useLayoutEffect(() => {
    committed.current = { scope, v2Ordering, snapshots };
  }, [scope, snapshots, v2Ordering]);
  return rows;
}
/** Explicit expand/collapse starts a new header layout; live facts do not. */
export function sidebarReadingRowKey(row: AttentionListRow): string {
  return row.kind === 'cluster-header' ? `${row.key}:${row.expanded}` : row.key;
}

interface ReadingSession {
  scope: string;
  held: boolean;
  heights: Readonly<Record<string, number>>;
}

// Protect a quick following click, then reclaim empty space even while hovering.
const READING_HEIGHT_HOLD_MS = 500;

/** Placement lasts for the reading session; geometry only lasts for a short
 * interaction window. Neither may keep obsolete unread or working facts. */
export function useSidebarReadingSession(surfaceRef: RefObject<HTMLElement>, enabled: boolean, scope: string) {
  const [session, setSession] = useState<ReadingSession>({ scope, held: false, heights: {} });
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !enabled) {
      setSession({ scope, held: false, heights: {} });
      return;
    }
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let protecting = false;
    const enter = () => {
      const heights = Object.fromEntries(
        [...surface.querySelectorAll<HTMLElement>('[data-sidebar-row-key]')].flatMap((row) => {
          const height = row.getBoundingClientRect().height;
          const key = row.dataset.sidebarRowKey;
          return key && height > 0 ? [[key, height]] : [];
        }),
      );
      protecting = true;
      clearTimeout(releaseTimer);
      setSession({ scope, held: true, heights });
      releaseTimer = setTimeout(() => {
        protecting = false;
        setSession((current) => (current.scope === scope ? { ...current, heights: {} } : current));
      }, READING_HEIGHT_HOLD_MS);
    };
    const leave = () => {
      protecting = false;
      clearTimeout(releaseTimer);
      setSession({ scope, held: false, heights: {} });
    };
    // Virtualization mounts rows inside the child without rendering this hook.
    // Join the current window without extending its deadline on live updates.
    const observer = new MutationObserver(() => {
      setSession((current) => {
        if (!protecting || !current.held || current.scope !== scope) return current;
        const growth = [...surface.querySelectorAll<HTMLElement>('[data-sidebar-row-key]')].flatMap((row) => {
          const key = row.dataset.sidebarRowKey;
          const height = row.getBoundingClientRect().height;
          return key && height > (current.heights[key] ?? 0) ? [[key, height] as const] : [];
        });
        return growth.length ? { ...current, heights: { ...current.heights, ...Object.fromEntries(growth) } } : current;
      });
    });
    observer.observe(surface, { childList: true, subtree: true });
    if (surface.matches(':hover')) enter();
    surface.addEventListener('pointerenter', enter);
    surface.addEventListener('pointerdown', enter);
    surface.addEventListener('pointerleave', leave);
    return () => {
      clearTimeout(releaseTimer);
      surface.removeEventListener('pointerenter', enter);
      surface.removeEventListener('pointerdown', enter);
      surface.removeEventListener('pointerleave', leave);
      observer.disconnect();
    };
  }, [surfaceRef, enabled, scope]);
  return enabled && session.scope === scope ? session : { scope, held: false, heights: {} };
}
