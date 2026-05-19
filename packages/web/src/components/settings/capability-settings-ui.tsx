'use client';

import type { MouseEvent } from 'react';
import { useMemo } from 'react';
import type { CapabilityBoardItem, CatFamily } from '../capability-board-ui';
import { SettingsResourceToggleSwitch } from '../SettingsResourceCard';
import { projectDisplayName } from './useCapabilityState';

export function ToggleSwitch({
  enabled,
  busy,
  onClick,
  title,
}: {
  enabled: boolean;
  busy: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  title?: string;
}) {
  return <SettingsResourceToggleSwitch enabled={enabled} busy={busy} onClick={onClick} title={title} />;
}

export function ProjectSelector({
  resolvedPath,
  knownProjects,
  currentSelection,
  onSwitch,
}: {
  resolvedPath: string;
  knownProjects: string[];
  currentSelection: string | null;
  onSwitch: (path: string | null) => void;
}) {
  const allPaths = useMemo(() => {
    const set = new Set<string>();
    if (resolvedPath) set.add(resolvedPath);
    for (const path of knownProjects) set.add(path);
    return Array.from(set);
  }, [resolvedPath, knownProjects]);

  if (allPaths.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 text-xs">
      <label htmlFor="cap-project-select" className="whitespace-nowrap text-cafe-muted">
        项目:
      </label>
      <select
        id="cap-project-select"
        value={currentSelection ?? ''}
        onChange={(event) => onSwitch(event.target.value || null)}
        className="min-w-0 flex-1 truncate rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-field-bg)] px-2 py-1.5 text-xs text-cafe-secondary"
      >
        <option value="">{projectDisplayName(resolvedPath)}</option>
        {allPaths
          .filter((path) => path !== resolvedPath || currentSelection !== null)
          .map((path) => (
            <option key={path} value={path}>
              {projectDisplayName(path)}
            </option>
          ))}
      </select>
    </div>
  );
}

export function PerCatToggles({
  item,
  catFamilies,
  toggling,
  onToggle,
}: {
  item: CapabilityBoardItem;
  catFamilies: CatFamily[];
  toggling: string | null;
  onToggle: (item: CapabilityBoardItem, enabled: boolean, catId?: string) => void;
}) {
  if (catFamilies.length === 0 || !item.cats) return null;
  const catEntries = Object.entries(item.cats);
  if (catEntries.length === 0) return null;

  return (
    <div className="border-t border-[var(--console-border-soft)] px-4 pb-3 pt-2">
      <span className="text-[10px] font-medium uppercase tracking-wider text-cafe-muted">按猫开关</span>
      <div className="mt-1.5 space-y-1">
        {catFamilies.map((family) => {
          const relevantCats = family.catIds.filter((catId) => catId in item.cats);
          if (relevantCats.length === 0) return null;
          return (
            <div key={family.id} className="space-y-1">
              {relevantCats.length > 1 && <span className="text-[10px] text-cafe-muted">{family.name}</span>}
              {relevantCats.map((catId) => {
                const enabled = item.cats[catId] ?? false;
                const busy = toggling === `${item.id}:${catId}`;
                return (
                  <div key={catId} className="flex items-center justify-between">
                    <span className="text-xs text-cafe-secondary">{catId}</span>
                    <ToggleSwitch
                      enabled={enabled}
                      busy={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggle(item, !enabled, catId);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
