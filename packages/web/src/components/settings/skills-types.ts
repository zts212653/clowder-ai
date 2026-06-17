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

export interface SkillEntry {
  name: string;
  category: string;
  trigger: string;
  description?: string;
  source?: 'cat-cafe' | 'external';
  globalEnabled?: boolean;
  mountPaths?: string[];
  mounts: SkillMount;
  mountHealth?: SkillMountHealth;
  requiresMcp: SkillMcpDependency[];
}

export interface SkillsStaleness {
  stale: boolean;
  currentHash?: string;
  recordedHash?: string;
  newSkills: string[];
  removedSkills: string[];
}

export interface MountIssue {
  skill: string;
  unmountedMountPoints: string[];
}

export interface SkillsData {
  skills: SkillEntry[];
  summary: {
    total: number;
    allMounted: boolean;
    registrationConsistent: boolean;
    registrationIssues?: {
      unregistered: string[];
      phantom: string[];
    };
    mountIssues?: MountIssue[];
  };
  staleness: SkillsStaleness | null;
}

export interface SkillsApiEntry extends Omit<SkillEntry, 'requiresMcp'> {
  requiresMcp?: SkillMcpDependency[];
}

export interface SkillsApiData extends Omit<SkillsData, 'skills'> {
  skills: SkillsApiEntry[];
}

export interface SettingsSkillItem {
  id: string;
  name: string;
  category: string;
  trigger: string;
  description?: string;
  source: 'cat-cafe' | 'external';
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
    source: 'cat-cafe' | 'external';
    enabled: boolean;
    cats: Record<string, boolean>;
    canToggle: boolean;
  } | null;
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

export function normalizeSkillsData(payload: SkillsApiData): SkillsData {
  return {
    ...payload,
    skills: payload.skills.map((skill) => ({
      ...skill,
      requiresMcp: skill.requiresMcp ?? [],
    })),
  };
}

function isNonPluginCatCafeSkillCapability(item: CapabilityBoardItem): boolean {
  return item.type === 'skill' && item.source === 'cat-cafe' && !item.pluginId;
}

export function composeSkillItems(governance: SkillsData, capabilityItems: CapabilityBoardItem[]): SettingsSkillItem[] {
  const capMap = new Map<string, CapabilityBoardItem>();
  const firstPartyCatCafeCapMap = new Map<string, CapabilityBoardItem>();
  for (const item of capabilityItems) {
    capMap.set(item.id, item);
    if (isNonPluginCatCafeSkillCapability(item)) {
      firstPartyCatCafeCapMap.set(item.id, item);
    }
  }

  const staleNewNames = new Set(governance.staleness?.newSkills ?? []);
  const staleRemovedNames = new Set(governance.staleness?.removedSkills ?? []);

  return governance.skills.map((skill) => {
    const isCatCafeSourceSkill = (skill.source ?? 'cat-cafe') === 'cat-cafe';
    const cap = (isCatCafeSourceSkill ? firstPartyCatCafeCapMap.get(skill.name) : undefined) ?? capMap.get(skill.name);
    const legacyMountedCount = getMountedCount(skill.mounts);
    const mountHealth =
      skill.mountHealth ??
      ({
        enabledMountPoints: MOUNT_POINT_KEYS,
        mountedCount: legacyMountedCount,
        requiredCount: MOUNT_POINT_KEYS.length,
        allMounted: legacyMountedCount === MOUNT_POINT_KEYS.length,
      } satisfies SkillMountHealth);
    return {
      id: skill.name,
      name: skill.name,
      category: skill.category,
      trigger: skill.trigger,
      description: skill.description,
      source: skill.source ?? cap?.source ?? 'cat-cafe',
      mountPaths: skill.mountPaths ?? cap?.mountPaths,
      pluginId: cap?.pluginId,
      governance: {
        mounts: skill.mounts,
        mountedCount: mountHealth.mountedCount,
        requiredMountCount: mountHealth.requiredCount,
        allMounted: mountHealth.allMounted,
        enabledMountPoints: mountHealth.enabledMountPoints,
        requiresMcp: skill.requiresMcp,
        isStaleNew: staleNewNames.has(skill.name),
        isStaleRemoved: staleRemovedNames.has(skill.name),
      },
      controls: cap
        ? {
            source: cap.source,
            enabled: cap.globalEnabled ?? cap.enabled,
            cats: cap.cats ?? {},
            canToggle: true,
          }
        : null,
    };
  });
}
