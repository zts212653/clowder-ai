import type { TrajectoryStep } from './AntigravityBridge.js';

export interface NormalizedAntigravityToolCall {
  toolName: string;
  input?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeAntigravityToolCall(step: TrajectoryStep): NormalizedAntigravityToolCall | undefined {
  const metadataInput = nonEmptyString(step.metadata?.toolCall?.argumentsJson);
  const directToolName = nonEmptyString(step.toolCall?.toolName);
  if (directToolName) {
    return { toolName: directToolName, input: metadataInput ?? nonEmptyString(step.toolCall?.input) };
  }

  const metadataToolName = nonEmptyString(step.metadata?.toolCall?.name);
  if (metadataToolName) {
    return { toolName: metadataToolName, input: metadataInput };
  }

  const mcpToolName = nonEmptyString(step.mcpTool?.toolCall?.name);
  if (mcpToolName) {
    return { toolName: mcpToolName, input: nonEmptyString(step.mcpTool?.toolCall?.argumentsJson) };
  }

  return undefined;
}
