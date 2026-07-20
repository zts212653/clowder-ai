import type { CapabilityBoardItem } from '../capability-board-ui';

export type StandardMountPointKey = 'claude' | 'codex' | 'gemini' | 'kimi';

export interface SkillMount {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  kimi: boolean;
  [mountPointId: string]: boolean;
}

export interface SkillMcpDependency {
  id: string;
  status: 'ready' | 'missing' | 'unresolved';
}

export interface SkillMountHealth {
  enabledMountPoints: string[];
  mountedCount: number;
  requiredCount: number;
  allMounted: boolean;
}

export interface SkillsSummary {
  total: number;
  allMounted: boolean;
  registrationConsistent: boolean;
}

export interface SettingsSkillItem {
  id: string;
  name: string;
  category: string;
  trigger: string;
  description?: string;
  source: 'cat-cafe' | 'external' | 'plugin';
  mountPaths?: string[];
  pluginId?: string;
  governance: {
    mounts: SkillMount;
    mountedCount: number;
    requiredMountCount: number;
    allMounted: boolean;
    enabledMountPoints: string[];
    requiresMcp: SkillMcpDependency[];
    isStaleNew: boolean;
    isStaleRemoved: boolean;
  };
  controls: {
    source: 'cat-cafe' | 'external' | 'plugin';
    enabled: boolean;
    cats: Record<string, boolean>;
    canToggle: boolean;
  };
}

export interface SkillProjectSyncSummary {
  totalProjects: number;
  syncedProjects: number;
  status: 'all' | 'partial' | 'none' | 'unknown';
}

export const ALL_CATEGORIES = '全部';
export const MOUNT_POINT_KEYS: StandardMountPointKey[] = ['claude', 'codex', 'gemini', 'kimi'];

export type SkillScope = 'all' | 'project';
export const SCOPE_ALL: SkillScope = 'all';
export const SCOPE_PROJECT: SkillScope = 'project';

export function getMountedCount(mounts: SkillMount): number {
  return MOUNT_POINT_KEYS.filter((key) => mounts[key]).length;
}

export function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

export function matchesSkillSearch(skill: SettingsSkillItem, needle: string): boolean {
  return `${skill.name} ${skill.category} ${skill.trigger} ${skill.description ?? ''}`.toLowerCase().includes(needle);
}

/** Staleness context derived from capabilities skillHealth. */
export interface SkillStalenessCtx {
  unregistered: string[];
  phantom: string[];
}

/**
 * Build skill items from capabilities data.
 *
 * Capabilities items are the sole iteration source — plugin skills
 * show up automatically via their CapabilityBoardItem entries.
 */
export function composeSkillItems(
  capabilityItems: CapabilityBoardItem[],
  staleness?: SkillStalenessCtx | null,
): SettingsSkillItem[] {
  const skillCaps = capabilityItems.filter((i) => i.type === 'skill');
  const staleNewNames = new Set(staleness?.unregistered ?? []);
  const staleRemovedNames = new Set(staleness?.phantom ?? []);

  return skillCaps.map((cap) => {
    const mounts: SkillMount = (cap.mounts as SkillMount) ?? {
      claude: false,
      codex: false,
      gemini: false,
      kimi: false,
    };
    const mountedCount = cap.mountHealth?.mountedCount ?? getMountedCount(mounts);
    const requiredMountCount = cap.mountHealth?.requiredCount ?? MOUNT_POINT_KEYS.length;
    const allMounted = cap.mountHealth?.allMounted ?? mountedCount === requiredMountCount;
    const enabledMountPoints = cap.mountHealth?.enabledMountPoints ?? MOUNT_POINT_KEYS;
    const trigger = cap.triggers?.join('、') || '';
    const category = cap.category ?? '未分类';
    return {
      id: cap.id,
      name: cap.id,
      category,
      trigger,
      description: cap.description,
      source: cap.source,
      mountPaths: cap.mountPaths,
      pluginId: cap.pluginId,
      governance: {
        mounts,
        mountedCount,
        requiredMountCount,
        allMounted,
        enabledMountPoints,
        requiresMcp: (cap.requiresMcp ?? []) as SkillMcpDependency[],
        isStaleNew: staleNewNames.has(cap.id),
        isStaleRemoved: staleRemovedNames.has(cap.id),
      },
      controls: {
        source: cap.source,
        enabled: cap.globalEnabled ?? cap.enabled,
        cats: cap.cats ?? {},
        canToggle: true,
      },
    };
  });
}
