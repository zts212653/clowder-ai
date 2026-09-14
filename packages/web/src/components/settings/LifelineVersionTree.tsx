'use client';

import type { VersionEpoch } from '@cat-cafe/shared';
import type { ReactNode } from 'react';

export interface VersionTreeRow {
  epoch: VersionEpoch;
  depth: number;
  parentVersion: number | null;
  isLastSibling: boolean;
  hasChildren: boolean;
  ancestorContinuations: boolean[];
}

interface LifelineVersionTreeProps {
  chain: VersionEpoch[];
  children: (row: VersionTreeRow) => ReactNode;
}

const TREE_STEP_PX = 56;
const VERSION_CENTER_PX = 23;

export function LifelineVersionTree({ chain, children }: LifelineVersionTreeProps) {
  return (
    <div className="min-w-max" data-version-tree>
      {flattenVersionTree(chain).map((row) => (
        <VersionTreeRowFrame key={`${row.epoch.version}:${row.epoch.startedAt}`} row={row}>
          {children(row)}
        </VersionTreeRowFrame>
      ))}
    </div>
  );
}

function VersionTreeRowFrame({ row, children }: { row: VersionTreeRow; children: ReactNode }) {
  const { epoch, depth } = row;
  return (
    <div
      data-version-node={epoch.version}
      data-parent-version={epoch.parentVersion ?? undefined}
      data-tree-depth={depth}
      className="relative min-h-11 min-w-0 py-1"
    >
      <VersionTreeConnectors row={row} />
      <div
        data-version-card
        data-active-version={String(epoch.isActive)}
        className={`relative z-[1] flex w-fit min-w-0 items-center gap-1.5 rounded-xl px-2 py-1.5 transition-colors ${
          epoch.isActive ? 'bg-[var(--console-active-bg)]' : ''
        }`}
        style={{ marginInlineStart: `${depth * TREE_STEP_PX}px` }}
      >
        {children}
      </div>
    </div>
  );
}

function VersionTreeConnectors({ row }: { row: VersionTreeRow }) {
  const { epoch, depth, parentVersion, isLastSibling, hasChildren, ancestorContinuations } = row;
  const nodeCenter = depth * TREE_STEP_PX + VERSION_CENTER_PX;
  const parentCenter = (depth - 1) * TREE_STEP_PX + VERSION_CENTER_PX;

  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 text-cafe-muted">
      {ancestorContinuations.map((continues, level) =>
        continues ? (
          <span
            // The level is structural and stable inside one ancestry path.
            // biome-ignore lint/suspicious/noArrayIndexKey: connector rails have no entity identity
            key={level}
            data-version-ancestor-rail={level}
            className="absolute inset-y-0 border-l border-[var(--console-border)]"
            style={{ left: `${level * TREE_STEP_PX + VERSION_CENTER_PX}px` }}
          />
        ) : null,
      )}
      {depth > 0 && parentVersion !== null && (
        <span data-version-edge={`${parentVersion}:${epoch.version}`}>
          <span
            className="absolute top-0 border-l border-[var(--console-border)]"
            style={{ left: `${parentCenter}px`, bottom: isLastSibling ? '50%' : 0 }}
          />
          <span
            className="absolute border-t border-[var(--console-border)]"
            style={{
              left: `${parentCenter}px`,
              top: '50%',
              width: `${TREE_STEP_PX - VERSION_CENTER_PX - 4}px`,
            }}
          />
          <span
            className="absolute -translate-y-1/2 text-xs leading-none"
            style={{ left: `${depth * TREE_STEP_PX - 7}px`, top: '50%' }}
          >
            ›
          </span>
        </span>
      )}
      {hasChildren && (
        <span
          data-version-child-rail={epoch.version}
          className="absolute bottom-0 border-l border-[var(--console-border)]"
          style={{ left: `${nodeCenter}px`, top: '50%' }}
        />
      )}
    </span>
  );
}

export function flattenVersionTree(chain: VersionEpoch[]): VersionTreeRow[] {
  const byVersion = new Map(chain.map((epoch) => [epoch.version, epoch] as const));
  const childrenByParent = new Map<number, VersionEpoch[]>();
  const roots: VersionEpoch[] = [];

  for (const epoch of chain) {
    const parentVersion = epoch.parentVersion;
    if (parentVersion === null || parentVersion === epoch.version || !byVersion.has(parentVersion)) {
      roots.push(epoch);
      continue;
    }
    const siblings = childrenByParent.get(parentVersion) ?? [];
    siblings.push(epoch);
    childrenByParent.set(parentVersion, siblings);
  }

  const rows: VersionTreeRow[] = [];
  const visited = new Set<number>();
  const visit = (
    epoch: VersionEpoch,
    depth: number,
    parentVersion: number | null,
    isLastSibling: boolean,
    ancestorContinuations: boolean[],
  ) => {
    if (visited.has(epoch.version)) return;
    visited.add(epoch.version);
    const children = (childrenByParent.get(epoch.version) ?? []).filter((child) => !visited.has(child.version));
    rows.push({
      epoch,
      depth,
      parentVersion,
      isLastSibling,
      hasChildren: children.length > 0,
      ancestorContinuations,
    });
    children.forEach((child, index) => {
      const childContinuations = depth === 0 ? [] : [...ancestorContinuations, !isLastSibling];
      visit(child, depth + 1, epoch.version, index === children.length - 1, childContinuations);
    });
  };

  roots.forEach((root, index) => {
    visit(root, 0, null, index === roots.length - 1, []);
  });
  // Corrupt/cyclic ancestry must remain visible rather than silently dropping versions.
  chain.forEach((epoch) => {
    if (!visited.has(epoch.version)) visit(epoch, 0, null, true, []);
  });
  return rows;
}
