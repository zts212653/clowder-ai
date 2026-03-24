/**
 * Capability Types — F041 统一能力模型
 *
 * 三猫的 MCP server 配置归一为统一内部表示。
 * 配置编排器从此格式生成三种 CLI 配置 (.mcp.json / .codex/config.toml / .gemini/settings.json)。
 */

/** MCP transport type — stdio (default) or remote HTTP (TD104) */
export type McpTransport = 'stdio' | 'streamableHttp';

/** MCP server descriptor — 统一内部模型 */
export interface McpServerDescriptor {
  /** MCP server name (e.g. 'cat-cafe', 'filesystem') */
  name: string;
  /** Transport type (default: 'stdio'). TD104: 'streamableHttp' for URL-based servers. */
  transport?: McpTransport;
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
  /** Origin: Cat Cafe's own MCP or user-configured external */
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
  /** Type of capability (F126: 'limb' for device/hardware nodes) */
  type: 'mcp' | 'skill' | 'limb';
  /** Global enabled state */
  enabled: boolean;
  /** Per-cat overrides (only stores differences from global) */
  overrides?: CatCapabilityOverride[];
  /** MCP server descriptor (only for type: 'mcp') */
  mcpServer?: Omit<McpServerDescriptor, 'name' | 'enabled' | 'source'>;
  /** Source origin */
  source: 'cat-cafe' | 'external';
}

/** Root schema for .cat-cafe/capabilities.json */
export interface CapabilitiesConfig {
  /** Schema version */
  version: 1;
  /** All registered capabilities */
  capabilities: CapabilityEntry[];
  /** F070: Governance pack metadata for this project */
  governancePack?: GovernancePackMeta;
}

/** Capabilities board response — what the GET API returns */
export interface CapabilityBoardItem {
  id: string;
  type: 'mcp' | 'skill' | 'limb';
  source: 'cat-cafe' | 'external';
  enabled: boolean;
  /** Per-cat effective state (global + overrides resolved) */
  cats: Record<string, boolean>;
  /** Description if available */
  description?: string;
  /** Skill trigger keywords (from SKILL.md frontmatter) */
  triggers?: string[];
  /** Skill category (from BOOTSTRAP.md, e.g. '三猫协作规则') */
  category?: string;
  /** Skill mount status per provider (symlink correctness check) */
  mounts?: Record<string, boolean>;
  /** MCP tools discovered via probe (only when ?probe=true) */
  tools?: McpToolInfo[];
  /** MCP connection status (only when ?probe=true) */
  connectionStatus?: 'connected' | 'disconnected' | 'unknown';
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
}

/** Skill mount health summary */
export interface SkillHealthSummary {
  /** All Cat Cafe skills correctly symlinked to all providers */
  allMounted: boolean;
  /** No orphaned skills or phantom BOOTSTRAP entries */
  registrationConsistent: boolean;
  /** Skills in source dir but not in BOOTSTRAP.md */
  unregistered: string[];
  /** Skills in BOOTSTRAP.md but not in source dir */
  phantom: string[];
}

/** Full GET /api/capabilities response (F041 re-open: includes family + project metadata) */
export interface CapabilityBoardResponse {
  items: CapabilityBoardItem[];
  catFamilies: CatFamily[];
  /** The resolved project path this response pertains to */
  projectPath: string;
  /** Skill mount health (only for cat-cafe skills) */
  skillHealth?: SkillHealthSummary;
  /** F070: Governance health for this project */
  governanceHealth?: GovernanceHealthSummary;
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

/** PATCH request body for toggling capabilities */
export interface CapabilityPatchRequest {
  /** Capability ID to modify */
  capabilityId: string;
  /** Capability type — required to disambiguate same-name MCP/skill entries */
  capabilityType: 'mcp' | 'skill' | 'limb';
  /** Scope: global toggle or per-cat override */
  scope: 'global' | 'cat';
  /** Required when scope is 'cat' */
  catId?: string;
  /** New enabled state */
  enabled: boolean;
  /** Target project path (multi-project support). If omitted, uses server default. */
  projectPath?: string;
}
