/**
 * Mount Rules — F228 Skill 挂载规则
 *
 * 描述 skill 应该 symlink-mount 到哪些 mount point 目录。
 * 替代 skill-mount.ts 中硬编码的 4-mount-point 假设
 * （claude/codex/gemini/kimi），让未来通过 ACP/A2A 接入的 client
 * 也能通过自定义路径挂载。
 */

/** Built-in standard mount point — fixed enum of known clients. */
export type StandardMountPointId = 'claude' | 'codex' | 'gemini' | 'kimi';

/** Ordered list of standard mount points (canonical iteration order). */
export const STANDARD_MOUNT_POINT_IDS: readonly StandardMountPointId[] = ['claude', 'codex', 'gemini', 'kimi'] as const;

/** Mount config for a standard mount point. */
export interface StandardMountPointRule {
  /** Whether to mount skills into this mount point's directory. */
  enabled: boolean;
  /** Skills directory path relative to projectRoot (e.g. ".claude/skills"). */
  path: string;
}

/** Custom mount point — for ACP/A2A or unknown clients. */
export interface CustomMountPointRule {
  /** Unique alias (e.g. "opencode") — used for UI display and dedup. */
  alias: string;
  /** Skills directory path relative to projectRoot (e.g. ".opencode/skills"). */
  path: string;
}

/** Root schema for mount rules (persisted in capabilities.json#mountRules). */
export interface MountRules {
  /** Schema version. */
  version: 1;
  /** Standard mount points — always contains all 4 entries. */
  mountPoints: Record<StandardMountPointId, StandardMountPointRule>;
  /** Custom mount paths for ACP/A2A/unknown clients (may be empty). */
  customPaths: CustomMountPointRule[];
}

// ─── F228 v2: Unified Schema Types ───────────────────────────────

/**
 * F228: Mount rule entry for capabilities.json v2.
 * Replaces the mount-point-keyed MountRules format for persistence;
 * readMountRules() adapter converts back to MountRules for downstream consumers.
 */
export interface MountRuleEntry {
  /** Mount point identifier: 'claude' | 'codex' | 'gemini' | 'kimi' (or custom). */
  name: string;
  /** Skills directory path relative to projectRoot (e.g. ".claude/skills"). */
  path: string;
  /** Whether to mount skills into this mount point's directory. */
  enabled: boolean;
}

/**
 * F228: Sync tracking state — replaces skills-state.json.
 * Stored at capabilities.json#skillsSync per project.
 * managedSkillNames is no longer stored — derived from capabilities[].source === 'cat-cafe'.
 */
export interface SkillsSyncState {
  /** Relative path from project root to skills source directory. */
  sourceRoot: string;
  /** SHA-256 hash of sorted skill names — detects additions/removals. */
  sourceManifestHash: string;
  /** ISO 8601 timestamp of last successful sync. */
  lastSyncedAt: string;
  /**
   * F228: Skills whose project-config disabled entry originated from a global
   * cascade default (not from explicit user action). On the next sync, these
   * entries are treated as "no local opinion" so a global re-enable cascades
   * correctly instead of being blocked by the stale project-config entry.
   *
   * Absent/empty = no cascade-disabled skills tracked.
   */
  cascadeDisabledSkills?: string[];
}

/** Canonical default mount rules — used when capabilities.json has no mountRules. */
export const DEFAULT_MOUNT_RULES: MountRules = {
  version: 1,
  mountPoints: {
    claude: { enabled: true, path: '.claude/skills' },
    codex: { enabled: true, path: '.codex/skills' },
    gemini: { enabled: true, path: '.gemini/skills' },
    kimi: { enabled: true, path: '.kimi/skills' },
  },
  customPaths: [],
};
