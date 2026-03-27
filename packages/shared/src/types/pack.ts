/**
 * F129: Pack System Types
 * Multi-Agent 共创世界的声明式 Mod 定义
 *
 * Terminal schema — 这是最终形态，不是脚手架。
 * See: docs/features/F129-pack-system-multi-agent-mod.md
 * See: docs/decisions/021-f129-pack-system-architecture.md
 */

/** Pack 五种类型 (KD-1: 统一用 Pack) */
export type PackType = 'domain' | 'scenario' | 'style' | 'bridge' | 'capability';

/** Constraint severity in guardrails */
export type ConstraintSeverity = 'block' | 'warn';

/** Constraint scope */
export type PackScope = 'all-cats' | 'specific-breeds';

/** Mask activation condition */
export type MaskActivation = 'always' | 'on-demand';

/** World Driver resolver type (KD-6: agent, not llm) */
export type ResolverType = 'code' | 'agent' | 'hybrid';

// ─── Pack Manifest (pack.yaml) ───────────────────────────────────────

export interface PackManifest {
  name: string;
  version: string;
  description: string;
  packType: PackType;
  author?: string;
  license?: string;
  compatibility?: PackCompatibility;
}

export interface PackCompatibility {
  catCafeVersion?: string;
}

// ─── Guardrails (guardrails.yaml) ────────────────────────────────────
// 硬约束轨: 只能加严，不能放宽 Core Rails (KD-9)

export interface PackGuardrails {
  constraints: PackConstraint[];
}

export interface PackConstraint {
  id: string;
  scope: PackScope;
  breeds?: string[];
  rule: string;
  severity: ConstraintSeverity;
}

// ─── Defaults (defaults.yaml) ────────────────────────────────────────
// 默认行为轨: 用户请求可覆盖 (KD-9)

export interface PackDefaults {
  behaviors: PackBehavior[];
}

export interface PackBehavior {
  id: string;
  scope: PackScope;
  breeds?: string[];
  behavior: string;
  overridable: true; // always true — enforced by schema
}

// ─── Masks (masks/*.yaml) ────────────────────────────────────────────
// 猫格面具: 叠加专业角色，不改核心身份 (KD-3)

export interface PackMask {
  id: string;
  name: string;
  roleOverlay: string;
  personalityOverlay?: string;
  expertise?: string[];
  activation: MaskActivation;
}

// ─── Workflows (workflows/*.yaml) ────────────────────────────────────
// 声明式工作流: 不是自由文本指令 (KD-2)

/** Allowed workflow actions — enum, not arbitrary strings */
export type WorkflowAction =
  | 'search-knowledge'
  | 'apply-mask'
  | 'check-guardrail'
  | 'notify-user'
  | 'switch-mode'
  | 'log-event';

export interface PackWorkflow {
  id: string;
  name: string;
  trigger: string;
  steps: PackWorkflowStep[];
}

export interface PackWorkflowStep {
  action: WorkflowAction;
  params?: Record<string, string | number | boolean>;
}

// ─── World Driver (world-driver.yaml) ────────────────────────────────
// 世界运转声明 (KD-6: resolver: code | agent | hybrid)

export interface PackWorldDriver {
  stateSchema?: Record<string, unknown>;
  roles?: string[];
  actions?: string[];
  resolver: ResolverType;
  canonRules?: string[];
  memoryPolicy?: string;
}

// ─── Compiled Output ─────────────────────────────────────────────────
// PackCompiler 的产物，SystemPromptBuilder 消费

export interface CompiledPackBlocks {
  packName: string;
  guardrailBlock: string | null;
  defaultsBlock: string | null;
  masksBlock: string | null;
  workflowsBlock: string | null;
  worldDriverSummary: string | null;
  warnings: string[];
}

// ─── Pack on Disk ────────────────────────────────────────────────────

export interface PackOnDisk {
  manifest: PackManifest;
  rootDir: string;
}
