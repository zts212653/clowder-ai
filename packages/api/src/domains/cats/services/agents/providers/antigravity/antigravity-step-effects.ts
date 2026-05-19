import type { TrajectoryStep } from './AntigravityBridge.js';

export type AntigravityEffectKind =
  | 'none'
  | 'text'
  | 'thinking'
  | 'tool_read'
  | 'side_effect_pending'
  | 'side_effect_done'
  | 'side_effect_failed'
  | 'upstream_error'
  | 'unknown_side_effect_capable';

export type AntigravityEffectType = 'code' | 'mcp' | 'shell' | 'artifact' | 'tool' | 'upstream' | 'unknown';

export interface AntigravityStepEffect {
  kind: AntigravityEffectKind;
  effectType?: AntigravityEffectType;
  toolName?: string;
  target?: string;
  sideEffectCapable: boolean;
  completedSideEffect: boolean;
  failedSideEffect: boolean;
  blocksBlindRetry: boolean;
  reason: string;
}

export interface AntigravityStepEffectSummary {
  effects: AntigravityStepEffect[];
  hasUnsafeSideEffect: boolean;
  hasCompletedSideEffect: boolean;
  hasFailedSideEffect: boolean;
  hasUpstreamError: boolean;
  blocksBlindRetry: boolean;
}

const READ_ONLY_MCP_TOOLS = new Set<string>([
  'grep_search',
  'list_dir',
  'read_file',
  'search_evidence',
  'cat_cafe_search_evidence',
  'graph_resolve',
  'cat_cafe_graph_resolve',
  'list_recent',
  'cat_cafe_list_recent',
  'view_file',
  'get_thread_context',
  'cat_cafe_get_thread_context',
  'list_threads',
  'cat_cafe_list_threads',
]);

const READ_ONLY_COMMAND_PREFIXES = [
  'cat ',
  'find ',
  'git diff',
  'git log',
  'git rev-list',
  'git rev-parse',
  'git show',
  'git status',
  'git worktree list',
  'grep ',
  'head ',
  'jq ',
  'ls',
  'pwd',
  'rg ',
  'sed -n ',
  'tail ',
  'wc ',
];

const WRITE_COMMAND_PATTERN =
  /(^|\s)(>|>>|apply_patch|cp\s|mkdir\s|mv\s|rm\s|sed\b.*\s(?:-[A-Za-z]*i(?:\S*)?|--in-place(?:=\S*)?)(\s|$)|tee\s|touch\s|pnpm\s+install|npm\s+install|git\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch))/;
const FIND_MUTATING_PRIMARY_PATTERN =
  /^find\b.*(?:\s-delete(?:\s|$)|\s-(?:exec|execdir|ok|okdir)\s|\s-f(?:print0|print|printf|ls)(?:\s|$))/;
const GIT_DIFF_OUTPUT_PATTERN = /^git\s+diff\b.*\s--output(?:=\S+|\s+\S+)?(?:\s|$)/;
const SHELL_CONTROL_OPERATOR_PATTERN = /[;&|<>`]|\$\(/;

function normalizeName(name: string | undefined): string | undefined {
  const normalized = name?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function hasStatus(step: TrajectoryStep, markers: string[]): boolean {
  const status = step.status.toUpperCase();
  return markers.some((marker) => status.includes(marker));
}

function isDone(step: TrajectoryStep): boolean {
  return hasStatus(step, ['DONE', 'FINISHED', 'COMPLETED', 'SUCCESS']);
}

function isFailed(step: TrajectoryStep): boolean {
  if (step.toolResult?.success === false) return true;
  return hasStatus(step, ['FAILED', 'ERROR', 'CANCELED', 'CANCELLED']);
}

function unsafeEffect(
  kind: AntigravityEffectKind,
  effectType: AntigravityEffectType,
  reason: string,
): AntigravityStepEffect {
  return {
    kind,
    effectType,
    sideEffectCapable: true,
    completedSideEffect: kind === 'side_effect_done',
    failedSideEffect: kind === 'side_effect_failed',
    blocksBlindRetry: true,
    reason,
  };
}

function safeEffect(kind: AntigravityEffectKind, reason: string): AntigravityStepEffect {
  return {
    kind,
    sideEffectCapable: false,
    completedSideEffect: false,
    failedSideEffect: false,
    blocksBlindRetry: false,
    reason,
  };
}

function effectKindFromStatus(step: TrajectoryStep): AntigravityEffectKind {
  if (isFailed(step)) return 'side_effect_failed';
  if (isDone(step)) return 'side_effect_done';
  return 'side_effect_pending';
}

function toolNameFromStep(step: TrajectoryStep): string | undefined {
  const fromToolCall = normalizeName(step.toolCall?.toolName);
  if (fromToolCall) return fromToolCall;
  const fromToolResult = normalizeName(step.toolResult?.toolName);
  if (fromToolResult) return fromToolResult;
  return normalizeName(step.metadata?.toolCall?.name);
}

function metadataString(step: TrajectoryStep, key: string): string | undefined {
  const value = step.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function recordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function commandLineFromMetadataToolCall(step: TrajectoryStep): string | undefined {
  const argumentsJson = step.metadata?.toolCall?.argumentsJson;
  if (!argumentsJson) return undefined;
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const args = parsed as Record<string, unknown>;
    return recordString(args, 'CommandLine') ?? recordString(args, 'commandLine');
  } catch {
    return undefined;
  }
}

export function isReadOnlyMcpTool(toolName: string | undefined): boolean {
  const normalized = normalizeName(toolName);
  if (!normalized) return false;
  for (const allowed of READ_ONLY_MCP_TOOLS) {
    if (normalized === allowed) return true;
    if (normalized.endsWith(`__${allowed}`)) return true;
  }
  return false;
}

function isReadOnlyCommand(commandLine: string | undefined): boolean {
  const command = commandLine?.trim().toLowerCase();
  if (!command) return false;
  if (SHELL_CONTROL_OPERATOR_PATTERN.test(command)) return false;
  if (FIND_MUTATING_PRIMARY_PATTERN.test(command)) return false;
  if (GIT_DIFF_OUTPUT_PATTERN.test(command)) return false;
  if (WRITE_COMMAND_PATTERN.test(command)) return false;
  for (const prefix of READ_ONLY_COMMAND_PREFIXES) {
    const normalizedPrefix = prefix.trimEnd();
    if (command === normalizedPrefix) return true;
    if (command.startsWith(`${normalizedPrefix} `)) return true;
  }
  return false;
}

export function classifyAntigravityStepEffect(step: TrajectoryStep): AntigravityStepEffect {
  if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
    const pr = step.plannerResponse;
    if (!pr) return safeEffect('none', 'empty planner response shell');
    if (pr.stopReason === 'STOP_REASON_CLIENT_STREAM_ERROR')
      return safeEffect('upstream_error', 'planner stream interrupted');
    if (pr.modifiedResponse) return safeEffect('text', 'planner emitted visible text');
    if (pr.response) return safeEffect('text', 'planner emitted visible text');
    if (pr.thinking) return safeEffect('thinking', 'planner emitted thinking only');
    return safeEffect('none', 'empty planner response');
  }

  if (step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
    return { ...safeEffect('upstream_error', 'upstream error message'), effectType: 'upstream' };
  }

  if (
    step.type === 'CORTEX_STEP_TYPE_CHECKPOINT' ||
    step.type === 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE' ||
    step.type === 'CORTEX_STEP_TYPE_USER_INPUT'
  ) {
    return safeEffect('none', 'non-effect checkpoint step');
  }

  if (step.type === 'CORTEX_STEP_TYPE_GENERATE_IMAGE') {
    return {
      ...unsafeEffect(effectKindFromStatus(step), 'artifact', 'generate_image creates an artifact outside chat text'),
      target: step.generateImage?.imageName,
    };
  }

  if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION') {
    return {
      ...unsafeEffect(effectKindFromStatus(step), 'code', 'code action may have already changed files'),
      target: metadataString(step, 'path'),
    };
  }

  if (step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND') {
    const command =
      step.runCommand?.commandLine ?? step.runCommand?.proposedCommandLine ?? commandLineFromMetadataToolCall(step);
    if (isReadOnlyCommand(command))
      return { ...safeEffect('tool_read', 'read-only shell command'), effectType: 'shell' };
    return {
      ...unsafeEffect(effectKindFromStatus(step), 'shell', 'shell command is unsafe unless explicitly read-only'),
      target: command,
    };
  }

  if (step.type === 'CORTEX_STEP_TYPE_MCP_TOOL') {
    const toolName = toolNameFromStep(step);
    if (isReadOnlyMcpTool(toolName)) {
      return {
        ...safeEffect('tool_read', 'reviewed read-only MCP tool'),
        effectType: 'mcp',
        toolName,
        target: toolName,
      };
    }
    return {
      ...unsafeEffect(effectKindFromStatus(step), 'mcp', 'MCP tool is unsafe unless allowlisted read-only'),
      toolName,
      target: toolName,
    };
  }

  const toolName = toolNameFromStep(step);
  if (toolName) {
    if (isReadOnlyMcpTool(toolName)) {
      return {
        ...safeEffect('tool_read', 'reviewed read-only Antigravity tool'),
        effectType: 'mcp',
        toolName,
        target: toolName,
      };
    }
    return {
      ...unsafeEffect(effectKindFromStatus(step), 'tool', 'shape fallback tool is unsafe by default'),
      toolName,
      target: toolName,
    };
  }

  return unsafeEffect('unknown_side_effect_capable', 'unknown', 'unknown step type is fail-closed');
}

export function summarizeAntigravityEffects(allEffects: AntigravityStepEffect[]): AntigravityStepEffectSummary {
  const effects = allEffects.filter((effect) => effect.sideEffectCapable || effect.kind === 'upstream_error');

  return {
    effects,
    hasUnsafeSideEffect: allEffects.some((effect) => effect.sideEffectCapable),
    hasCompletedSideEffect: allEffects.some((effect) => effect.completedSideEffect),
    hasFailedSideEffect: allEffects.some((effect) => effect.failedSideEffect),
    hasUpstreamError: allEffects.some((effect) => effect.kind === 'upstream_error'),
    blocksBlindRetry: allEffects.some((effect) => effect.blocksBlindRetry),
  };
}

export function summarizeAntigravityStepEffects(steps: TrajectoryStep[]): AntigravityStepEffectSummary {
  return summarizeAntigravityEffects(steps.map(classifyAntigravityStepEffect));
}
