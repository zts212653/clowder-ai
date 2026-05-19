import type { CapabilityBoardItem } from '../capability-board-ui';

export interface SkillMount {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  kimi: boolean;
}

export interface SkillMcpDependency {
  id: string;
  status: 'ready' | 'missing' | 'unresolved';
}

export interface SkillEntry {
  name: string;
  category: string;
  trigger: string;
  description?: string;
  mounts: SkillMount;
  requiresMcp: SkillMcpDependency[];
}

export interface SkillsStaleness {
  stale: boolean;
  newSkills: string[];
  removedSkills: string[];
}

export interface SkillConflict {
  skillName: string;
  projectTarget: string;
  userTarget: string;
  activeLayer: 'user' | 'project';
}

export interface SkillsData {
  skills: SkillEntry[];
  summary: {
    total: number;
    allMounted: boolean;
    registrationConsistent: boolean;
  };
  staleness: SkillsStaleness | null;
  conflicts: SkillConflict[];
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
  governance: {
    mounts: SkillMount;
    mountedCount: number;
    requiresMcp: SkillMcpDependency[];
    hasConflict: boolean;
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

export const ALL_CATEGORIES = '全部';
export const PROVIDER_KEYS: Array<keyof SkillMount> = ['claude', 'codex', 'gemini', 'kimi'];

export function getMountedCount(mounts: SkillMount): number {
  return PROVIDER_KEYS.filter((key) => mounts[key]).length;
}

export function dependencyTone(status: SkillMcpDependency['status']): string {
  if (status === 'ready') return 'bg-emerald-100 text-emerald-700';
  if (status === 'missing') return 'bg-rose-100 text-rose-700';
  return 'bg-conn-amber-bg text-conn-amber-text';
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

export function composeSkillItems(governance: SkillsData, capabilityItems: CapabilityBoardItem[]): SettingsSkillItem[] {
  const capMap = new Map<string, CapabilityBoardItem>();
  for (const item of capabilityItems) {
    capMap.set(item.id, item);
  }

  const conflictNames = new Set(governance.conflicts.map((c) => c.skillName));
  const staleNewNames = new Set(governance.staleness?.newSkills ?? []);
  const staleRemovedNames = new Set(governance.staleness?.removedSkills ?? []);

  return governance.skills.map((skill) => {
    const cap = capMap.get(skill.name);
    return {
      id: skill.name,
      name: skill.name,
      category: skill.category,
      trigger: skill.trigger,
      description: skill.description,
      governance: {
        mounts: skill.mounts,
        mountedCount: getMountedCount(skill.mounts),
        requiresMcp: skill.requiresMcp,
        hasConflict: conflictNames.has(skill.name),
        isStaleNew: staleNewNames.has(skill.name),
        isStaleRemoved: staleRemovedNames.has(skill.name),
      },
      controls: cap
        ? {
            source: cap.source,
            enabled: cap.enabled,
            cats: cap.cats ?? {},
            canToggle: true,
          }
        : null,
    };
  });
}
