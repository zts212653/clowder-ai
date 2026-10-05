import type { WorkspaceMode } from '@/lib/workspace-modes';
import { SETTINGS_SECTIONS } from './settings-nav-config';

/**
 * F322 设置与管理 — the 11 first-level destinations (home-northstar README 1.6 §3, 旧入口 → 新位置).
 *
 * This is a MAP over what already exists, not new pages: every one of the 14 old settings sections keeps its id,
 * renderer, `/settings?s=` deep link and extra positioning params; the other entries open the object that already owns
 * them (a full route, or the conversation's Workspace panel). Nothing here stores data.
 *
 * Order and grouping are the decided design: three groups separated by hairlines, no group titles.
 */
/** The Workspace 猫猫团队 panel is a second-level item of 猫猫团队 with its own pin identity (it is NOT `dest:team`). */
export const TEAM_WORKSPACE_PIN_ID = 'dest:team-workspace';
export const TEAM_WORKSPACE_LABEL = '成员能力与路由状态';

export type SecondLevelItem =
  | { kind: 'section'; sectionId: string }
  | { kind: 'workspace-team'; label: string; pinId: string };

export type SettingsDestination =
  | { kind: 'sections'; items: readonly SecondLevelItem[] }
  | { kind: 'theme' }
  | { kind: 'route'; path: string }
  | { kind: 'workspace-mode'; mode: Exclude<WorkspaceMode, 'dev' | 'team'> }
  /** The capability-evolution home has no typed open request yet (F307); it is opened from the Workspace launcher. */
  | { kind: 'workspace-launcher' };

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
  {
    id: 'team',
    label: '猫猫团队',
    icon: 'users',
    group: 1,
    destination: {
      kind: 'sections',
      items: [
        { kind: 'section', sectionId: 'members' },
        { kind: 'section', sectionId: 'profiles' },
        { kind: 'section', sectionId: 'concierge' },
        { kind: 'workspace-team', label: TEAM_WORKSPACE_LABEL, pinId: TEAM_WORKSPACE_PIN_ID },
      ],
    },
  },
  { id: 'schedule', label: '调度', icon: 'timer', group: 1, destination: { kind: 'workspace-mode', mode: 'schedule' } },
  { id: 'evolution', label: '能力进化', icon: 'sparkles', group: 1, destination: { kind: 'workspace-launcher' } },
  { id: 'eval', label: '评估', icon: 'chart-pie', group: 1, destination: { kind: 'workspace-mode', mode: 'eval' } },
  {
    id: 'connect',
    label: '连接与扩展',
    icon: 'plug',
    group: 2,
    destination: sections('accounts', 'im', 'marketplace', 'skills', 'mcp', 'plugins'),
  },
  {
    id: 'system',
    label: '系统',
    icon: 'settings',
    group: 2,
    destination: sections('system', 'rules', 'voice', 'notify', 'ops'),
  },
  { id: 'theme', label: '主题', icon: 'palette', group: 2, destination: { kind: 'theme' } },
  {
    id: 'community',
    label: '社区',
    icon: 'message-circle',
    group: 3,
    destination: { kind: 'workspace-mode', mode: 'community' },
  },
  { id: 'starry', label: '猫猫星球', icon: 'planet', group: 3, destination: { kind: 'route', path: '/starry' } },
  {
    id: 'mission',
    label: 'Mission Hub',
    icon: 'mission',
    group: 3,
    destination: { kind: 'route', path: '/mission-hub' },
  },
  { id: 'signals', label: '信号', icon: 'signal', group: 3, destination: { kind: 'route', path: '/signals' } },
];

/** Default landing: 猫猫团队 › 成员与运行时 — the same default as the old settings page (`DEFAULT_SECTION`). */
export const DEFAULT_SETTINGS_ENTRY_ID = 'team';

export function findEntry(entryId: string): SettingsEntry | undefined {
  return SETTINGS_IA.find((entry) => entry.id === entryId);
}

/** Which first-level entry owns an old settings section (every one of the 14 has exactly one). */
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
    return { kind: 'workspace-team', id: pinId, label: TEAM_WORKSPACE_LABEL, icon: 'users' };
  }
  if (pinId.startsWith(DEST_PREFIX)) {
    const entry = findEntry(pinId.slice(DEST_PREFIX.length));
    return entry ? { kind: 'entry', id: pinId, label: entry.label, icon: entry.icon, entry } : null;
  }
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === pinId);
  return section ? { kind: 'section', id: pinId, label: section.label, icon: section.icon } : null;
}
