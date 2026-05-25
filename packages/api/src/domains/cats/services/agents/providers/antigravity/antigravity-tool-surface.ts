import type { TrajectoryStep } from './AntigravityBridge.js';

const LS_OWNED_APPROVAL_TOOLS = new Set<string>([
  'ask_permission',
  'write_to_file',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

function normalizeToolName(toolName: string | undefined): string | undefined {
  const normalized = toolName?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

export function toolNameFromWaitingStep(step: TrajectoryStep | null | undefined): string | undefined {
  return (
    normalizeToolName(step?.metadata?.toolCall?.name) ??
    normalizeToolName(step?.toolCall?.toolName) ??
    normalizeToolName(step?.toolResult?.toolName)
  );
}

export function isLsOwnedApprovalTool(toolName: string | undefined): boolean {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return false;
  for (const allowed of LS_OWNED_APPROVAL_TOOLS) {
    if (normalized === allowed) return true;
    if (normalized.endsWith(`__${allowed}`)) return true;
  }
  return false;
}
