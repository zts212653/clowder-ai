/**
 * Capability Types — F041 统一能力模型
 *
 * 三猫的 MCP server 配置归一为统一内部表示。
 * 配置编排器从此格式生成三种 CLI 配置 (.mcp.json / .codex/config.toml / .gemini/settings.json)。
 */

import type { MarketplaceEcosystem } from './marketplace.js';
import type { MountRuleEntry, SkillsSyncState } from './mount-rules.js';

// ─── F249: MCP Sync Types ────────────────────────────────────────

/**
 * F249: Structured env entry for MCP servers.
 * Supports ${ENV_VAR} variable references resolved at invoke time.
 */
export interface McpEnvEntry {
  key: string;
  /** Value or `${ENV_VAR}` reference resolved from process.env at invoke time. */
  value: string;
  /** true = Console UI masks the value by default (eye toggle to reveal). */
  sensitive: boolean;
}

/**
 * F249: Per-project MCP sync tracking state.
 * Stored at capabilities.json#mcpSync per project.
 */
export interface McpSyncState {
  /** SHA-256 hash of global MCP config at last sync. */
  sourceConfigHash: string;
  /** ISO 8601 timestamp of last successful sync. */
  lastSyncedAt: string;
  /**
   * MCP IDs whose project-config disabled entry (blockedCats = all cats)
   * originated from a global cascade, not explicit user action.
   */
  cascadeDisabledMcps?: string[];
}

/** MCP transport type — stdio (default) or remote HTTP (TD104) */
export type McpTransport = 'stdio' | 'streamableHttp';

/** MCP server descriptor — 统一内部模型 */
export interface McpServerDescriptor {
  /** MCP server name (e.g. 'cat-cafe', 'filesystem') */
  name: string;
  /** Transport type (default: 'stdio'). TD104: 'streamableHttp' for URL-based servers. */
  transport?: McpTransport;
  /** Optional local resolver hint for machine-specific stdio servers (e.g. pencil). */
  resolver?: string;
  /** Command to spawn (e.g. 'node') — required for stdio, empty for streamableHttp */
  command: string;
  /** Command arguments — stdio only */
  args: string[];
  /** Remote MCP endpoint URL — streamableHttp only */
  url?: string;
  /** HTTP headers for remote transport (e.g. Authorization) — streamableHttp only */
  headers?: Record<string, string>;
  /** Optional environment variables — stdio only */
  env?: Record<string, string>;
  /** Whether globally enabled */
  enabled: boolean;
  /** Optional working directory */
  workingDir?: string;
  /** Origin: Clowder AI's own MCP or user-configured external */
  source: 'cat-cafe' | 'external';
}

/** Per-cat override for a capability */
export interface CatCapabilityOverride {
  /** Cat ID */
  catId: string;
  /** Whether enabled for this cat (overrides global) */
  enabled: boolean;
}

/** Single capability entry in capabilities.json */
export interface CapabilityEntry {
  /** Unique capability ID (usually MCP server name) */
  id: string;
  /** Type of capability (F126: 'limb' for device/hardware nodes; F202 Phase 2: 'schedule' for plugin-managed tasks) */
  type: 'mcp' | 'skill' | 'limb' | 'schedule';
  /** Global enabled state (MCP/limb/schedule still use this; skill uses globalEnabled) */
  enabled: boolean;
  /**
   * F228: Global enabled state for skills. Skill code reads/writes this field exclusively.
   * MCP/limb/schedule continue using `enabled` until their migration.
   * Migration: startup fills this from `enabled` for skill entries that lack it.
   */
  globalEnabled?: boolean;
  /**
   * @deprecated Legacy per-cat overrides. Superseded by `blockedCats`.
   * Migration converts to `blockedCats` at startup; runtime ignores this field.
   * Kept on the type for legacy config deserialization only.
   */
  overrides?: CatCapabilityOverride[];
  /** MCP server descriptor (only for type: 'mcp') */
  mcpServer?: Omit<McpServerDescriptor, 'name' | 'enabled' | 'source'>;
  /** Source origin */
  source: 'cat-cafe' | 'external';
  /**
   * F228: Mount point IDs where this skill is actually mounted in the current project.
   * Only for type: 'skill'. Values are mount point IDs from mountRules (e.g. 'claude', 'codex').
   * Empty array = skill is available globally but not mounted in this project.
   * Absent = pre-v2 entry (migration will populate from filesystem).
   */
  mountPaths?: string[];
  /** F146-D: Source ecosystem when installed from marketplace */
  ecosystem?: MarketplaceEcosystem;
  /** F146-C: Version lock (AC-C2) */
  lockVersion?: LockVersion;
  /** F146-C: Persistent probe state (AC-C3/C4/C6) */
  probeState?: ProbeState;
  /** F202: Plugin that owns this capability (for plugin-managed resources) */
  pluginId?: string;
  /** F202: Limb node ID (for type: 'limb') — enables deregistration when YAML is unreadable */
  limbNodeId?: string;
  /** F202 Phase 2: Runtime task ID assigned by TaskRunnerV2 (schedule resources only) */
  scheduleTaskId?: string;
  /**
   * F249: Blacklist — cat IDs that cannot use this MCP.
   * Canonical per-cat access field for MCP (supersedes legacy `overrides`).
   * undefined/absent = all cats can use it. Empty array = all cats can use it.
   * Contains all cat IDs = fully disabled.
   * Only meaningful for type: 'mcp'.
   */
  blockedCats?: string[];
  /**
   * F249: Project-level MCP server config override (full replacement).
   * When present, this project uses this config instead of the global mcpServer.
   * Absent = use global mcpServer.
   * Only meaningful for type: 'mcp' in project-level capabilities.json.
   */
  mcpServerOverride?: Omit<McpServerDescriptor, 'name' | 'enabled' | 'source'>;
  /**
   * Which external config file this MCP was discovered from.
   * e.g. "claude-project", "codex-user", "gemini-user", "kimi-project".
   * Absent for manually added or cat-cafe managed entries.
   */
  discoveredFrom?: string;
}

/** Sanitized MCP server details included in the capability board payload. */
export interface CapabilityBoardMcpServer {
  /** Transport type (default: stdio). */
  transport?: McpTransport;
  /** Optional local resolver hint for managed stdio servers. */
  resolver?: string;
  /** Command to spawn (stdio only). Included only for capability owner sessions. */
  command?: string;
  /** Command arguments (stdio only). Included only for capability owner sessions. */
  args?: string[];
  /** Remote MCP endpoint URL (streamableHttp only). Included only for capability owner sessions. */
  url?: string;
  /** Redacted HTTP headers for remote transport. */
  headers?: Record<string, string>;
  /** Redacted environment variables. */
  env?: Record<string, string>;
  /** Environment variable names for read-only display without exposing values. */
  envKeys?: string[];
}

/** Root schema for .cat-cafe/capabilities.json */
export interface CapabilitiesConfig {
  /** Schema version (v2 adds mountRules/defaultMountRules/skillsSync) */
  version: 1 | 2;
  /** All registered capabilities */
  capabilities: CapabilityEntry[];
  /** F070: Governance pack metadata for this project */
  governancePack?: GovernancePackMeta;
  /**
   * F228: Global default mount rules — only present in the main project.
   * Defines which mount points are enabled and their skills directory paths.
   * External projects inherit these when their own mountRules is null/absent.
   */
  defaultMountRules?: MountRuleEntry[];
  /**
   * F228: Project-level mount rule overrides.
   * null/absent = inherit defaultMountRules from the main project.
   * Present = this project's own mount point configuration.
   */
  mountRules?: MountRuleEntry[] | null;
  /**
   * F228: Sync tracking — replaces skills-state.json.
   * Records the last sync hash and timestamp per project.
   */
  skillsSync?: SkillsSyncState;
  /**
   * F249: MCP sync tracking per project.
   * Records the global MCP config hash at last sync.
   */
  mcpSync?: McpSyncState;
  /**
   * Tracks the last completed external MCP discovery pass.
   * When absent or < CURRENT_DISCOVERY_VERSION, a one-time import from
   * external config files (.claude/mcp.json, etc.) runs on next GET.
   * After import, the version is stamped and subsequent GETs skip discovery.
   */
  discoveryVersion?: number;
}

/** Capabilities board response — what the GET API returns */
export interface CapabilityBoardItem {
  id: string;
  type: 'mcp' | 'skill' | 'limb';
  source: 'cat-cafe' | 'external';
  enabled: boolean;
  /** F228: Global enabled for skills (mirrors CapabilityEntry.globalEnabled in board response) */
  globalEnabled?: boolean;
  /** Per-cat effective state (global + overrides resolved) */
  cats: Record<string, boolean>;
  /** Description if available */
  description?: string;
  /** Skill trigger keywords (from SKILL.md frontmatter) */
  triggers?: string[];
  /** Skill category (from manifest.yaml, e.g. '开发流程') */
  category?: string;
  /** Skill mount status per mount point (symlink correctness check) */
  mounts?: Record<string, boolean>;
  /** Mount point aliases where this skill is intentionally mounted in the selected project. */
  mountPaths?: string[];
  /** MCP tools discovered via probe (only when ?probe=true) */
  tools?: McpToolInfo[];
  /** MCP connection status (only when ?probe=true) */
  connectionStatus?: 'connected' | 'disconnected' | 'unknown';
  /** Sanitized MCP server config for settings UI (MCP only). */
  mcpServer?: CapabilityBoardMcpServer;
  /** F146-D: Capability layer (L1=MCP, L2=Skill, L3=Extension) */
  layer?: 'L1' | 'L2' | 'L3';
  /** F146-D: Source ecosystem (from marketplace install) */
  ecosystem?: MarketplaceEcosystem;
  /** F146-D: Version lock info (from Phase C install governance) */
  lockVersion?: LockVersion;
  /** F202: Plugin that owns this capability */
  pluginId?: string;
  /** F249: Blacklist — cat IDs that cannot use this MCP in this project. */
  blockedCats?: string[];
  /** F249: Whether this MCP has a project-level config override. */
  hasOverride?: boolean;
  /** Which external config file this MCP was discovered from (e.g. "claude-project"). */
  discoveredFrom?: string;
}

/** Lightweight MCP tool info for board display */
export interface McpToolInfo {
  name: string;
  description?: string;
}

/** Cat family grouping for the capability board UI */
export interface CatFamily {
  /** Breed ID (e.g. 'ragdoll') */
  id: string;
  /** Display name (e.g. '布偶猫') */
  name: string;
  /** All catIds belonging to this family */
  catIds: string[];
  /** Per-cat display labels — catId → "布偶猫(Opus) - catId" */
  catNames?: Record<string, string>;
}

/** Skill mount health summary */
export interface SkillHealthSummary {
  /** All Clowder AI skills correctly symlinked to all mount points */
  allMounted: boolean;
  /** Source dir and capabilities.json skill sets are consistent */
  registrationConsistent: boolean;
  /** Skills in source dir but not in capabilities.json */
  unregistered: string[];
  /** Skills in capabilities.json but not in source dir */
  phantom: string[];
}

/** Full GET /api/capabilities response (F041 re-open: includes family + project metadata) */
export interface CapabilityBoardResponse {
  items: CapabilityBoardItem[];
  catFamilies: CatFamily[];
  /** The resolved project path this response pertains to */
  projectPath: string;
  /** All known project paths (main project + governance registry entries) for multi-project selector */
  knownProjectPaths?: string[];
  /** Skill mount health (only for cat-cafe skills) */
  skillHealth?: SkillHealthSummary;
  /** F070: Governance health for this project */
  governanceHealth?: GovernanceHealthSummary;
  /** F249: All cat IDs with display names — frontend uses to render per-cat toggles. */
  allCats?: Array<{ catId: string; displayName: string }>;
}

// ─── F070: Portable Governance Types ──────────────────────────────

/** F070: Governance rule priority in Conflict Contract */
export type GovernanceCategory = 'hard-constraint' | 'workflow' | 'methodology' | 'advisory';

/** F070: Single rule in the portable governance pack */
export interface GovernanceRule {
  readonly id: string;
  readonly category: GovernanceCategory;
  readonly description: string;
  readonly immutable: boolean;
}

/** F070: Versioned governance pack metadata stored per-project */
export interface GovernancePackMeta {
  readonly packVersion: string;
  readonly checksum: string;
  readonly syncedAt: number;
  readonly confirmedByUser: boolean;
}

/** F070: Per-project governance health */
export interface GovernanceHealthSummary {
  readonly projectPath: string;
  readonly status: 'healthy' | 'stale' | 'missing' | 'never-synced';
  readonly packVersion: string | null;
  readonly lastSyncedAt: number | null;
  readonly findings: readonly GovernanceFinding[];
}

export interface GovernanceFinding {
  readonly category: GovernanceCategory;
  readonly name: string;
  readonly status: 'present' | 'missing' | 'stale';
}

/** F070: Bootstrap operation report (persisted for audit) */
export interface BootstrapReport {
  readonly projectPath: string;
  readonly timestamp: number;
  readonly packVersion: string;
  readonly actions: readonly BootstrapAction[];
  readonly dryRun: boolean;
}

export interface BootstrapAction {
  readonly file: string;
  readonly action: 'created' | 'updated' | 'skipped' | 'symlinked';
  readonly reason: string;
}

/** F070 Phase 2: Structured mission context for external project dispatch */
export interface DispatchMissionPack {
  /** 1-3 sentences: what this dispatch is for */
  readonly mission: string;
  /** External project's own work item ID, or thread title as fallback */
  readonly workItem: string;
  /** Current workflow phase */
  readonly phase: string;
  /** Up to 3 completion criteria */
  readonly doneWhen: readonly string[];
  /** Related entry links */
  readonly links: readonly string[];
}

// ─── F070 Phase 3: Execution Backflow Types ─────────────────────────

/** F070 Phase 3: Per-criterion pass/fail result from mission pack evaluation */
export interface DoneWhenResult {
  readonly criterion: string;
  readonly met: boolean;
  readonly evidence: string;
}

/** F070 Phase 3: Structured execution result captured after dispatch completion */
export interface DispatchExecutionDigest {
  readonly id: string;
  readonly userId: string;
  readonly projectPath: string;
  readonly threadId: string;
  readonly catId: string;
  readonly missionPack: DispatchMissionPack;
  readonly completedAt: number;
  readonly summary: string;
  readonly filesChanged: readonly string[];
  readonly status: 'completed' | 'partial' | 'blocked';
  readonly doneWhenResults: readonly DoneWhenResult[];
  readonly nextSteps: readonly string[];
}

// ─── F146 Phase C: Install Governance Types ─────────────────────────

/** Version lock record — written on install (AC-C2) */
export interface LockVersion {
  source: 'marketplace' | 'npm' | 'git' | 'local';
  version: string;
  channel?: string;
  installedAt: string;
  installedBy: string;
}

/** Persistent probe state (AC-C3/C4/C6) */
export interface ProbeState {
  status: 'ready' | 'probe_failed' | 'not_probed';
  lastProbed?: string;
  failureReason?: string;
  declaredTools?: string[];
  probedTools?: string[];
}

// ─── F146: MCP Marketplace Write-Path Types ─────────────────────────

/** POST /api/capabilities/mcp/install request body */
export interface McpInstallRequest {
  id: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  resolver?: string;
  projectPath?: string;
  ecosystem?: MarketplaceEcosystem;
  /**
   * F249: When true, cascade the new MCP entry to all governance-registered projects.
   * When false/absent, only save to global config with globalEnabled=false.
   */
  syncAll?: boolean;
  /**
   * F249 §8.3: When true + projectPath present, clear mcpServerOverride to restore global config.
   * The MCP entry's mcpServer (synced from global) becomes the active config again.
   */
  clearOverride?: boolean;
}

/** POST /api/capabilities/mcp/preview response */
export interface McpInstallPreview {
  entry: CapabilityEntry;
  cliConfigsAffected: string[];
  willProbe: boolean;
  risks: string[];
}

/** DELETE /api/capabilities/mcp/:id query params */
export interface McpDeleteParams {
  hard?: boolean;
  projectPath?: string;
}

/** Audit log entry (.cat-cafe/audit.jsonl) */
export interface CapabilityAuditEntry {
  timestamp: string;
  userId: string;
  action: 'install' | 'delete' | 'update' | 'toggle' | 'revoke';
  capabilityId: string;
  before: CapabilityEntry | null;
  after: CapabilityEntry | null;
}

/** PATCH request body for toggling capabilities */
export interface CapabilityPatchRequest {
  /**
   * Capability ID to modify (single skill).
   * Optional when capabilityIds[] is provided (batch mode).
   * At least one of capabilityId or capabilityIds[] must be present.
   */
  capabilityId?: string;
  /**
   * F228 batch mode: toggle multiple skills in one request.
   * When provided, overrides capabilityId — all skills share the same
   * scope/enabled/mountPointId. Config is written once and sync runs once.
   */
  capabilityIds?: string[];
  /** Capability type — required to disambiguate same-name MCP/skill entries */
  capabilityType: 'mcp' | 'skill' | 'limb';
  /** Optional source discriminator for same-name capability rows returned by GET. */
  source?: 'cat-cafe' | 'external';
  /** Optional plugin discriminator for plugin-owned same-name rows returned by GET. */
  pluginId?: string;
  /**
   * Scope of the toggle:
   * - 'global': toggle global enabled state (for skills: propagates to all projects)
   * - 'project': toggle project-level mount (for skills: only affects mountPaths + symlinks, not enabled)
   * - 'cat': per-cat override (MCP only — rejected for skills since file-level symlinks can't differentiate cats)
   */
  scope: 'global' | 'project' | 'cat';
  /** Required when scope is 'cat' */
  catId?: string;
  /**
   * F228: Target mount point for per-mount-point toggle (skill scope='project' only).
   * When set, only the specified mount point's symlink is created/removed.
   * Omit to toggle all enabled mount points at once.
   */
  mountPointId?: string;
  /** New enabled state */
  enabled: boolean;
  /** Target project path (multi-project support). If omitted, uses server default. */
  projectPath?: string;
}
