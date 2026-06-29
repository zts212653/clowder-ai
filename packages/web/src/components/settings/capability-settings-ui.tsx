'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useMemo } from 'react';
import type { CapabilityBoardItem, CatFamily } from '../capability-board-ui';
import { HubIcon } from '../hub-icons';
import {
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { SettingsText } from './primitives';
import { projectDisplayName } from './useCapabilityState';

// ── ScopeTabs (shared global/project tab bar) ──────────────────────────────

export interface ScopeTab {
  key: string;
  label: string;
  count: number;
}

/**
 * Underline tab bar for global/project scope — shared by Skill and MCP pages.
 *
 * `actions` renders right-aligned buttons (MCP uses this for "新增 MCP" etc).
 */
export function ScopeTabs({
  tabs,
  activeKey,
  onTabChange,
  ariaLabel,
  actions,
}: {
  tabs: ScopeTab[];
  activeKey: string;
  onTabChange: (key: string) => void;
  ariaLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--console-border-soft)]">
      <nav aria-label={ariaLabel} className="flex">
        {tabs.map((tab) => {
          const active = tab.key === activeKey;
          return (
            <button
              key={tab.key}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => onTabChange(tab.key)}
              className={`inline-flex items-center px-5 py-2.5 text-sm font-semibold transition-colors ${
                active
                  ? 'border-b-2 border-[var(--console-button-emphasis)] text-[var(--console-button-emphasis)]'
                  : 'text-cafe-muted hover:text-cafe-secondary'
              }`}
            >
              {tab.label}
              <span className={`ml-1 text-xs ${active ? 'opacity-80' : 'text-cafe-muted'}`}>{tab.count}</span>
            </button>
          );
        })}
      </nav>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// ── CapabilityRow (shared card/row layout for MCP and Skill items) ───────────

/**
 * Shared card row for capability items (MCP & Skill).
 *
 * Both pages render the same structural layout: avatar → name/description →
 * badges → toggle + action buttons → optional expanded content.
 * Only the content differs (MCP shows transport info; Skill shows category).
 */
export function CapabilityRow({
  name,
  description,
  subInfo,
  subInfoMono = false,
  onClick,
  badges,
  actions,
  expandedContent,
}: {
  /** Display name (also drives avatar letter). */
  name: string;
  /** Description line below the name. */
  description?: string;
  /** Optional third line (MCP: transport info; Skill: category). */
  subInfo?: string;
  /** Render subInfo in monospace (default: false). */
  subInfoMono?: boolean;
  /** Click handler for the card's main clickable area. */
  onClick?: () => void;
  /** Badges rendered between name area and actions. */
  badges?: ReactNode;
  /** Toggle + action buttons rendered in the action group. */
  actions?: ReactNode;
  /** Content shown below the main row (e.g. per-cat toggles, mount points). */
  expandedContent?: ReactNode;
}) {
  return (
    <div className={settingsResourceCardClass}>
      <div className={settingsResourceRowClass}>
        <button
          type="button"
          onClick={onClick}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-4"
          style={{ textAlign: 'left' }}
        >
          <div className={settingsResourceAvatarClass}>{name.charAt(0).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <SettingsText as="p" variant="sm" tone="default" className="font-bold">
              {name}
            </SettingsText>
            <SettingsText as="p" tone="secondary" className="mt-0.5 truncate">
              {description || '—'}
            </SettingsText>
            {subInfo && (
              <SettingsText as="p" tone="muted" className={`mt-0.5 truncate${subInfoMono ? ' font-mono' : ''}`}>
                {subInfo}
              </SettingsText>
            )}
          </div>
        </button>
        {badges && <div className="flex shrink-0 items-center gap-2">{badges}</div>}
        {actions && <div className={settingsResourceActionGroupClass}>{actions}</div>}
      </div>
      {expandedContent}
    </div>
  );
}

const AVATAR_COLORS = ['#C65F3D', '#8B6E5A', '#A0522D', '#7B6B63', '#9B7653', '#6F5946'];

export function avatarColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function ToggleSwitch({
  enabled,
  busy,
  onClick,
  title,
  disabled,
}: {
  enabled: boolean;
  busy: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <SettingsResourceToggleSwitch enabled={enabled} busy={busy} onClick={onClick} title={title} disabled={disabled} />
  );
}

export function ProjectSelector({
  resolvedPath,
  knownProjects,
  currentSelection,
  onSwitch,
  alwaysShow,
}: {
  resolvedPath: string;
  knownProjects: string[];
  currentSelection: string | null;
  onSwitch: (path: string | null) => void;
  /** When true, show a read-only project label even when there's only one project */
  alwaysShow?: boolean;
}) {
  const allPaths = useMemo(() => {
    const set = new Set<string>();
    if (resolvedPath) set.add(resolvedPath);
    for (const path of knownProjects) set.add(path);
    return Array.from(set);
  }, [resolvedPath, knownProjects]);

  if (allPaths.length === 0 && !alwaysShow) return null;
  if (allPaths.length <= 1 && !alwaysShow) return null;

  // Single project with alwaysShow: read-only label showing current project
  if (allPaths.length <= 1) {
    const displayPath = allPaths[0] || resolvedPath;
    if (!displayPath) return null;
    return (
      <div className="flex items-center gap-2 text-xs">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-field-bg)] px-2 py-1.5 text-xs text-cafe-secondary">
          {projectDisplayName(displayPath)}
        </code>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <select
        id="cap-project-select"
        aria-label="选择项目"
        value={currentSelection ?? ''}
        onChange={(event) => onSwitch(event.target.value || null)}
        className="min-w-0 flex-1 truncate rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-field-bg)] px-2 py-1.5 text-xs text-cafe-secondary"
      >
        <option value="">{projectDisplayName(resolvedPath)}</option>
        {allPaths
          .filter((path) => path !== resolvedPath)
          .map((path) => (
            <option key={path} value={path}>
              {projectDisplayName(path)}
            </option>
          ))}
      </select>
    </div>
  );
}

export function PluginManagedLink({ pluginId }: { pluginId: string }) {
  return (
    <a
      href="/settings?s=plugins"
      onClick={(event) => event.stopPropagation()}
      title={`由插件 ${pluginId} 管理，前往插件集成`}
      className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe-accent"
    >
      <HubIcon name="puzzle" className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">插件管理</span>
    </a>
  );
}

export function PerCatToggles({
  item,
  catFamilies,
  toggling,
  onToggle,
  disabled,
}: {
  item: CapabilityBoardItem;
  catFamilies: CatFamily[];
  toggling: string | null;
  onToggle: (item: CapabilityBoardItem, enabled: boolean, catId?: string) => void;
  disabled?: boolean;
}) {
  if (catFamilies.length === 0 || !item.cats) return null;
  const catEntries = Object.entries(item.cats);
  if (catEntries.length === 0) return null;

  return (
    <div className="px-4 pb-3 pt-2">
      <span className="text-micro font-medium uppercase tracking-wider text-cafe-muted">按猫开关</span>
      <div className="mt-1.5 space-y-1">
        {catFamilies.map((family) => {
          const relevantCats = family.catIds.filter((catId) => catId in item.cats);
          if (relevantCats.length === 0) return null;
          return (
            <div key={family.id} className="space-y-1">
              {relevantCats.length > 1 && <span className="text-micro text-cafe-muted">{family.name}</span>}
              {relevantCats.map((catId) => {
                const enabled = item.cats[catId] ?? false;
                const busy = toggling === `${item.id}:${catId}`;
                const catLabel = family.catNames?.[catId] ?? catId;
                return (
                  <div key={catId} className="flex items-center justify-between">
                    <span className="text-xs text-cafe-secondary">{catLabel}</span>
                    <ToggleSwitch
                      enabled={enabled}
                      busy={busy}
                      disabled={disabled}
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
