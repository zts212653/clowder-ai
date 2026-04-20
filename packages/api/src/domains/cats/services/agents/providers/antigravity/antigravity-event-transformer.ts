import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import type { TrajectoryStep } from './AntigravityBridge.js';

const log = createModuleLogger('antigravity-event-transformer');

const CAPACITY_PATTERNS = [/high traffic/i, /rate limit/i, /too many requests/i, /try again/i, /overloaded/i];

export function isCapacityError(message: string): boolean {
  return CAPACITY_PATTERNS.some((p) => p.test(message));
}

export type StepBucket =
  | 'terminal_output'
  | 'partial_output'
  | 'thinking'
  | 'tool_pending'
  | 'tool_error'
  | 'checkpoint'
  | 'unknown_activity';

export function classifyStep(step: TrajectoryStep): StepBucket {
  // Known content-bearing types
  if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
    const pr = step.plannerResponse;
    if (!pr) return 'checkpoint';
    if (pr.stopReason === 'STOP_REASON_CLIENT_STREAM_ERROR') return 'tool_error';
    if (pr.modifiedResponse || pr.response) return 'terminal_output';
    if (pr.thinking) return 'thinking';
    return 'checkpoint'; // empty plannerResponse — nothing to show
  }
  if (step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') return 'tool_error';

  // Known tool types
  if (step.type === 'CORTEX_STEP_TYPE_TOOL_CALL') return 'tool_pending';
  if (step.type === 'CORTEX_STEP_TYPE_TOOL_RESULT') {
    return step.toolResult?.success === false ? 'tool_error' : 'tool_pending';
  }
  if (step.type === 'CORTEX_STEP_TYPE_MCP_TOOL') {
    return step.toolResult?.success === false ? 'tool_error' : 'tool_pending';
  }

  // Known silent types (no user-facing output)
  if (
    step.type === 'CORTEX_STEP_TYPE_CHECKPOINT' ||
    step.type === 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE' ||
    step.type === 'CORTEX_STEP_TYPE_USER_INPUT'
  ) {
    return 'checkpoint';
  }

  // Shape-based fallback for unknown types (e.g. GREP_SEARCH, FILE_EDIT, TERMINAL_COMMAND)
  if (step.toolResult?.success === false) return 'tool_error';
  if (step.toolCall || step.toolResult) return 'tool_pending';

  return 'unknown_activity'; // unknown type, no tool data — logged but not sent to frontend
}

export function transformTrajectorySteps(
  steps: TrajectoryStep[],
  catId: CatId,
  metadata: MessageMetadata,
): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (const step of steps) {
    const bucket = classifyStep(step);

    switch (bucket) {
      case 'terminal_output': {
        const pr = step.plannerResponse!;
        if (pr.thinking) {
          messages.push({
            type: 'system_info',
            catId,
            content: JSON.stringify({ type: 'thinking', text: pr.thinking }),
            metadata,
            timestamp: Date.now(),
          });
        }
        messages.push({
          type: 'text',
          catId,
          content: (pr.modifiedResponse || pr.response)!,
          metadata,
          timestamp: Date.now(),
        });
        break;
      }

      case 'thinking': {
        const pr = step.plannerResponse!;
        messages.push({
          type: 'system_info',
          catId,
          content: JSON.stringify({ type: 'thinking', text: pr.thinking }),
          metadata,
          timestamp: Date.now(),
        });
        break;
      }

      case 'checkpoint':
        break;

      case 'tool_pending': {
        if (step.toolCall) {
          messages.push({
            type: 'system_info',
            catId,
            content: JSON.stringify({ type: 'tool_activity', toolName: step.toolCall.toolName }),
            metadata,
            timestamp: Date.now(),
          });
          let parsedInput: Record<string, unknown> | undefined;
          try {
            parsedInput = step.toolCall.input ? JSON.parse(step.toolCall.input) : undefined;
          } catch {
            parsedInput = step.toolCall.input ? { raw: step.toolCall.input } : undefined;
          }
          messages.push({
            type: 'tool_use',
            catId,
            toolName: step.toolCall.toolName,
            toolInput: parsedInput,
            metadata,
            timestamp: Date.now(),
          });
        }
        if (step.toolResult) {
          messages.push({
            type: 'tool_result',
            catId,
            toolName: step.toolResult.toolName,
            content: step.toolResult.output,
            metadata,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'tool_error': {
        if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
          log.warn('stream_error: stopReason=%s', step.plannerResponse?.stopReason);
          messages.push({
            type: 'error',
            catId,
            error: 'Antigravity model stream error (STOP_REASON_CLIENT_STREAM_ERROR)',
            errorCode: 'stream_error',
            metadata,
            timestamp: Date.now(),
          });
        } else if (step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' && step.errorMessage?.error) {
          const err = step.errorMessage.error;
          const rawText = err.userErrorMessage || err.modelErrorMessage || 'Unknown Antigravity error';
          const errorCode = isCapacityError(rawText) ? 'model_capacity' : 'upstream_error';
          log.warn(
            '%s: user=%s model=%s stepType=%s',
            errorCode,
            err.userErrorMessage,
            err.modelErrorMessage,
            step.type,
          );
          if (errorCode === 'model_capacity') {
            messages.push({
              type: 'provider_signal',
              catId,
              content: JSON.stringify({
                type: 'warning',
                message: `上游模型服务端繁忙（容量不足），非 Clowder AI 系统故障。(${rawText.slice(0, 100)})`,
              }),
              metadata,
              timestamp: Date.now(),
            });
          }
          const errorText =
            errorCode === 'model_capacity'
              ? `⚠️ 上游模型服务端容量不足（服务器繁忙），非 Clowder AI 系统故障。原始信息：${rawText}`
              : rawText;
          messages.push({
            type: 'error',
            catId,
            error: errorText,
            errorCode,
            metadata,
            timestamp: Date.now(),
          });
        } else if (step.toolResult) {
          const tr = step.toolResult;
          messages.push({
            type: 'error',
            catId,
            error: `Tool ${tr.toolName} failed: ${tr.error || 'unknown error'}`,
            errorCode: 'tool_error',
            metadata,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'unknown_activity':
        log.debug('unknown step type %s (status=%s), skipping frontend emission', step.type, step.status);
        break;
    }
  }

  return messages;
}
