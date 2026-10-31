import { isWorkspaceMode, type WorkspaceMode } from '@/lib/workspace-modes';
import {
  resolveFileTarget,
  resolveTeamWorkspaceTarget,
  resolveWorkspaceDestinationTarget,
} from './real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

function numberIdenticalLabels(groups: [string, WorkspaceSurfaceDescriptor[]][], labels: Map<string, string>): void {
  const reserved = new Set(labels.values());
  for (const [label, group] of groups) {
    let number = 1;
    for (const surface of [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      while (reserved.has(`${label} (${number})`)) number++;
      const unique = `${label} (${number++})`;
      reserved.add(unique);
      labels.set(surface.id, unique);
    }
  }
}

function modeTitle(
  surface: WorkspaceSurfaceDescriptor,
  modeLabels?: Readonly<Record<WorkspaceMode, string>>,
  voiceLabel?: string,
  statusLabel?: string,
): string {
  const target = resolveWorkspaceDestinationTarget(surface);
  if (voiceLabel && target?.destinationRef === 'host:voice') return voiceLabel;
  if (statusLabel && target?.destinationRef === 'host:status') return statusLabel;
  if (!modeLabels || surface.type !== 'workspace' || surface.renderer !== 'workspace-destination') return surface.title;
  if (resolveTeamWorkspaceTarget(surface)) return modeLabels.team;
  const mode = target?.destinationRef.startsWith('mode:') ? target.destinationRef.slice(5) : null;
  return isWorkspaceMode(mode) ? modeLabels[mode] : surface.title;
}

function pathOrContextLabel(surface: WorkspaceSurfaceDescriptor, title: string): string {
  const file = resolveFileTarget(surface);
  if (file) return file.path;
  return surface.context ? `${title} · ${surface.context}` : title;
}

/** Display-only disambiguation shared by inline, overflow and classic chrome. */
export function workbenchTabLabels(
  surfaces: readonly WorkspaceSurfaceDescriptor[],
  modeLabels?: Readonly<Record<WorkspaceMode, string>>,
  voiceLabel?: string,
  statusLabel?: string,
): ReadonlyMap<string, string> {
  const labels = new Map(
    surfaces.map((surface) => [surface.id, modeTitle(surface, modeLabels, voiceLabel, statusLabel)]),
  );
  const duplicates = () => {
    const groups = new Map<string, WorkspaceSurfaceDescriptor[]>();
    for (const surface of surfaces) {
      const label = labels.get(surface.id) ?? surface.title;
      groups.set(label, [...(groups.get(label) ?? []), surface]);
    }
    return [...groups.entries()].filter(([, group]) => group.length > 1);
  };
  for (const [, group] of duplicates()) {
    for (const surface of group) {
      labels.set(surface.id, pathOrContextLabel(surface, labels.get(surface.id) ?? surface.title));
    }
  }
  for (const [label, group] of duplicates()) {
    for (const surface of group) {
      const file = resolveFileTarget(surface);
      if (file) labels.set(surface.id, `${label} · ${file.worktreeId}`);
    }
  }
  // Identically named non-file owners may have no distinguishing public context.
  // Stable identity order assigns readable numbers without changing descriptors.
  numberIdenticalLabels(duplicates(), labels);
  return labels;
}
