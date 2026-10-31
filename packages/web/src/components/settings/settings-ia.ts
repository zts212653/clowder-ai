import { canonicalSettingsSectionId } from '@/lib/settings-section-id';
import type { WorkspaceMode } from '@/lib/workspace-modes';
import { SETTINGS_SECTIONS } from './settings-nav-config';

/**
 * F322 设置与管理 — eight settings destinations (home-northstar README §0.5, 2026-10-30).
 *
 * This is a MAP over what already exists, not new pages: each current settings section keeps its id,
 * renderer, `/settings?s=` deep link and extra positioning params; the other entries open the object that already owns
 * them (a full route, or the conversation's Workspace panel). Nothing here stores data.
 *
 * Order and grouping are the decided design: three groups separated by hairlines, no group titles.
 */
/** Saved Workspace team shortcuts keep their own identity, distinct from settings `dest:team`. */
export const TEAM_WORKSPACE_PIN_ID = 'dest:team-workspace';
export const TEAM_WORKSPACE_LABEL = '成员能力与路由状态';

export type SecondLevelItem = { kind: 'section'; sectionId: string };

export type SettingsDestination =
  | { kind: 'sections'; items: readonly SecondLevelItem[] }
  | { kind: 'theme' }
  | { kind: 'you' }
  | { kind: 'route'; path: string }
  | { kind: 'workspace-mode'; mode: Exclude<WorkspaceMode, 'dev' | 'team'> }
  | { kind: 'evolution-home' };

export interface SettingsEntry {
  /** Stable id; pinned destinations are stored as `dest:<id>` so they can never collide with a section id (`system`). */
  id: string;
  label: string;
  /** Key into the shared HubIcon registry. */
  icon: string;
  group: 1 | 2 | 3;
  destination: SettingsDestination;
}

const sections = (...ids: string[]): SettingsDestination => ({
  kind: 'sections',
  items: ids.map((sectionId) => ({ kind: 'section', sectionId }) as const),
});

export const SETTINGS_IA: readonly SettingsEntry[] = [
  { id: 'you', label: '你', icon: 'user', group: 1, destination: { kind: 'you' } },
  {
    id: 'team',
    label: '猫猫团队',
    icon: 'paw',
    group: 1,
    destination: {
      kind: 'sections',
      items: [
        { kind: 'section', sectionId: 'members' },
        { kind: 'section', sectionId: 'accounts' },
        { kind: 'section', sectionId: 'profiles' },
        { kind: 'section', sectionId: 'concierge' },
      ],
    },
  },
  {
    id: 'connect',
    label: '连接与扩展',
    icon: 'plug',
    group: 2,
    destination: sections('marketplace', 'skills', 'mcp', 'plugins'),
  },
  {
    id: 'system',
    label: '系统',
    icon: 'settings',
    group: 2,
    destination: sections('system', 'rules', 'voice', 'notify', 'ops'),
  },
  { id: 'theme', label: '主题', icon: 'palette', group: 2, destination: { kind: 'theme' } },
  { id: 'starry', label: '猫猫星球', icon: 'planet', group: 3, destination: { kind: 'route', path: '/starry' } },
  {
    id: 'mission',
    label: '功能看板',
    icon: 'mission',
    group: 3,
    destination: { kind: 'route', path: '/mission-hub' },
  },
  { id: 'signals', label: '信号', icon: 'signal', group: 3, destination: { kind: 'route', path: '/signals' } },
];

/** Compatibility for already-saved rail pins only; these tools are opened from Workspace +. */
const LEGACY_WORKSPACE_ENTRIES: readonly SettingsEntry[] = [
  { id: 'schedule', label: '调度', icon: 'timer', group: 1, destination: { kind: 'workspace-mode', mode: 'schedule' } },
  { id: 'evolution', label: '能力进化', icon: 'sparkles', group: 1, destination: { kind: 'evolution-home' } },
  { id: 'eval', label: '评估', icon: 'chart-pie', group: 1, destination: { kind: 'workspace-mode', mode: 'eval' } },
  {
    id: 'community',
    label: '社区',
    icon: 'message-circle',
    group: 3,
    destination: { kind: 'workspace-mode', mode: 'community' },
  },
];

/** Let the original Workspace tool remove its saved shortcut without restoring a settings entry. */
export function legacyWorkspacePinId(destination: { kind: string; id: string }): string | null {
  if (destination.kind === 'mode' && destination.id === 'team') return TEAM_WORKSPACE_PIN_ID;
  const entry = LEGACY_WORKSPACE_ENTRIES.find(
    ({ destination: target }) =>
      (target.kind === 'workspace-mode' && destination.kind === 'mode' && target.mode === destination.id) ||
      (target.kind === 'evolution-home' &&
        destination.kind === 'workspace' &&
        destination.id === 'capability-evolution'),
  );
  return entry ? destPinId(entry.id) : null;
}

/** Default landing: 猫猫团队 › 成员与运行时 — the same default as the old settings page (`DEFAULT_SECTION`). */
export const DEFAULT_SETTINGS_ENTRY_ID = 'team';

export function findEntry(entryId: string): SettingsEntry | undefined {
  return SETTINGS_IA.find((entry) => entry.id === entryId);
}

/** Which first-level entry owns a current settings section (each has exactly one). */
export function entryForSection(sectionId: string): SettingsEntry | undefined {
  return SETTINGS_IA.find(
    (entry) =>
      entry.destination.kind === 'sections' &&
      entry.destination.items.some((item) => item.kind === 'section' && item.sectionId === sectionId),
  );
}

export function sectionLabel(sectionId: string): string {
  return SETTINGS_SECTIONS.find((section) => section.id === sectionId)?.label ?? sectionId;
}

/** `?s=` value → the entry it lives under; `theme` is the one new value, everything else is an old section id. */
export function entryForSelection(selection: string): SettingsEntry | undefined {
  if (selection === 'you') return findEntry('you');
  return selection === 'theme' ? findEntry('theme') : entryForSection(selection);
}

// ── pins: anything in 设置与管理 can be pinned above the mailbox ──

const DEST_PREFIX = 'dest:';
export const destPinId = (entryId: string): string => `${DEST_PREFIX}${entryId}`;

export type ResolvedPin =
  | { kind: 'section'; id: string; label: string; icon: string }
  | { kind: 'entry'; id: string; label: string; icon: string; entry: SettingsEntry }
  | { kind: 'workspace-team'; id: string; label: string; icon: string };

/** Old pins are bare section ids and stay valid; new pins are `dest:<entry id>`. Unknown ids resolve to null (hidden, never crash). */
export function resolvePin(pinId: string): ResolvedPin | null {
  if (pinId === TEAM_WORKSPACE_PIN_ID) {
    return { kind: 'workspace-team', id: pinId, label: TEAM_WORKSPACE_LABEL, icon: 'paw' };
  }
  if (pinId.startsWith(DEST_PREFIX)) {
    const entryId = pinId.slice(DEST_PREFIX.length);
    const entry = findEntry(entryId) ?? LEGACY_WORKSPACE_ENTRIES.find((candidate) => candidate.id === entryId);
    return entry ? { kind: 'entry', id: pinId, label: entry.label, icon: entry.icon, entry } : null;
  }
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === canonicalSettingsSectionId(pinId));
  return section ? { kind: 'section', id: section.id, label: section.label, icon: section.icon } : null;
}
