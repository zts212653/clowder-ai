import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import type { TrajectoryStep } from './AntigravityBridge.js';
import { normalizeAntigravityToolCall } from './antigravity-tool-call-normalizer.js';

const log = createModuleLogger('antigravity-event-transformer');

// --- Error Taxonomy (F061 Phase 3) ---

export type UpstreamErrorKind = 'capacity' | 'network' | 'stream_interrupted' | 'invalid_tool_call' | 'unknown';

export interface UpstreamErrorInfo {
  kind: UpstreamErrorKind;
  transient: boolean;
  rawReason: string;
}

const CAPACITY_PATTERNS = [
  /high traffic/i,
  /rate limit/i,
  /too many requests/i,
  /overloaded/i,
  /exhausted your capacity/i,
  /quota will reset/i,
];

const NETWORK_PATTERNS = [
  /network.*issue/i,
  /connection.*(?:error|refused|reset|closed)/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /(?:network|connect|server).*\btry again\b/i,
];

export function isCapacityError(message: string): boolean {
  return CAPACITY_PATTERNS.some((p) => p.test(message));
}

export function isNetworkError(message: string): boolean {
  return NETWORK_PATTERNS.some((p) => p.test(message)) && !isCapacityError(message);
}

function isInvalidToolCallError(message: string): boolean {
  return /invalid tool call|produced an invalid tool/i.test(message);
}

export function classifyUpstreamError(rawReason: string, stopReason?: string): UpstreamErrorInfo {
  if (stopReason === 'STOP_REASON_CLIENT_STREAM_ERROR') {
    return { kind: 'stream_interrupted', transient: true, rawReason };
  }
  if (isInvalidToolCallError(rawReason)) {
    return { kind: 'invalid_tool_call', transient: false, rawReason };
  }
  if (isCapacityError(rawReason)) {
    return { kind: 'capacity', transient: true, rawReason };
  }
  if (isNetworkError(rawReason)) {
    return { kind: 'network', transient: true, rawReason };
  }
  return { kind: 'unknown', transient: false, rawReason };
}

const HUMAN_ERROR_MESSAGES: Record<UpstreamErrorKind, string> = {
  capacity: '上游模型服务繁忙',
  network: '网络连接异常',
  stream_interrupted: '连接中断',
  invalid_tool_call: '工具调用失败',
  unknown: '上游服务异常',
};

export function humanErrorMessage(kind: UpstreamErrorKind): string {
  return HUMAN_ERROR_MESSAGES[kind];
}

function formatAntigravityUpstreamError(message: string): string {
  if (!isInvalidToolCallError(message)) return message;
  return (
    `Antigravity 上游拒绝了一次 invalid tool call：${message} ` +
    '这类 ERROR_MESSAGE 没有回传 attempted toolName；通常是模型调用了不在 live MCP tool list 里的工具。' +
    'Clowder AI 的 agent-key tools ' +
    '(cat_cafe_post_message, cat_cafe_get_thread_context, cat_cafe_list_threads, cat_cafe_cross_post_message) ' +
    '只有在持久 Antigravity MCP 进程拿到 CAT_CAFE_AGENT_KEY_FILE(S) 后才会出现；' +
    '在它们可见前，请改用只读 MCP 工具或 HTTP callback fallback。'
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metadataString(step: TrajectoryStep, key: string): string | undefined {
  const value = step.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function formatCodeActionFailure(step: TrajectoryStep): string {
  const operation = metadataString(step, 'operation');
  const path = metadataString(step, 'path');
  const reason = metadataString(step, 'error') ?? step.error?.shortError ?? step.error?.fullError;
  const details = [
    operation ? `operation=${operation}` : undefined,
    path ? `path=${path}` : undefined,
    step.status ? `status=${step.status}` : undefined,
  ].filter(Boolean);
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return reason ? `Code action failed${suffix}: ${reason}` : `Code action failed${suffix}`;
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
  if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION') {
    if (step.toolResult?.success === false) return 'tool_error';
    return ['ERROR', 'FAILED', 'CANCELED', 'CANCELLED'].some((marker) => step.status.includes(marker))
      ? 'tool_error'
      : 'tool_pending';
  }

  // Known silent types (no user-facing output)
  if (
    step.type === 'CORTEX_STEP_TYPE_CHECKPOINT' ||
    step.type === 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE' ||
    step.type === 'CORTEX_STEP_TYPE_USER_INPUT'
  ) {
    return 'checkpoint';
  }

  // F172 Phase G: built-in generate_image step — silent in the chat stream;
  // surfaced via the post-invocation brain scanner that yields a media_gallery
  // rich block. Suppresses the "unknown step type" log noise.
  if (step.type === 'CORTEX_STEP_TYPE_GENERATE_IMAGE') {
    return 'checkpoint';
  }

  // Shape-based fallback for unknown types (e.g. GREP_SEARCH, FILE_EDIT, TERMINAL_COMMAND)
  if (step.toolResult?.success === false) return 'tool_error';
  if (normalizeAntigravityToolCall(step) || step.toolResult) return 'tool_pending';

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
          ...(step.catCafeTextMode ? { textMode: step.catCafeTextMode } : {}),
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
        if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION' && !step.toolCall && !step.toolResult) {
          messages.push({
            type: 'system_info',
            catId,
            content: JSON.stringify({
              type: 'code_action',
              status: step.status,
              operation: step.metadata?.operation,
              path: step.metadata?.path,
            }),
            metadata,
            timestamp: Date.now(),
          });
        }
        const toolCall = normalizeAntigravityToolCall(step);
        if (toolCall) {
          messages.push({
            type: 'system_info',
            catId,
            content: JSON.stringify({ type: 'tool_activity', toolName: toolCall.toolName }),
            metadata,
            timestamp: Date.now(),
          });
          let parsedInput: Record<string, unknown> | undefined;
          try {
            parsedInput = toolCall.input ? JSON.parse(toolCall.input) : undefined;
          } catch {
            parsedInput = toolCall.input ? { raw: toolCall.input } : undefined;
          }
          messages.push({
            type: 'tool_use',
            catId,
            toolName: toolCall.toolName,
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
        if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION' && !step.toolResult) {
          messages.push({
            type: 'error',
            catId,
            error: formatCodeActionFailure(step),
            errorCode: 'code_action_error',
            metadata,
            timestamp: Date.now(),
          });
        } else if (step.type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
          const upstreamError = classifyUpstreamError(
            step.plannerResponse?.stopReason ?? '',
            step.plannerResponse?.stopReason,
          );
          log.warn('stream_error: stopReason=%s kind=%s', step.plannerResponse?.stopReason, upstreamError.kind);
          messages.push({
            type: 'error',
            catId,
            error: humanErrorMessage(upstreamError.kind),
            errorCode: 'stream_error',
            metadata: { ...metadata, upstreamError },
            timestamp: Date.now(),
          });
        } else if (step.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' && step.errorMessage?.error) {
          const err = step.errorMessage.error;
          const rawText = err.userErrorMessage || err.modelErrorMessage || 'Unknown Antigravity error';
          const upstreamError = classifyUpstreamError(rawText);
          const errorCode =
            upstreamError.kind === 'capacity'
              ? 'model_capacity'
              : upstreamError.kind === 'network'
                ? 'network_error'
                : 'upstream_error';
          log.warn(
            '%s: user=%s model=%s stepType=%s kind=%s',
            errorCode,
            err.userErrorMessage,
            err.modelErrorMessage,
            step.type,
            upstreamError.kind,
          );
          if (upstreamError.transient) {
            messages.push({
              type: 'provider_signal',
              catId,
              content: JSON.stringify({
                type: 'warning',
                message: humanErrorMessage(upstreamError.kind),
              }),
              metadata: { ...metadata, upstreamError },
              timestamp: Date.now(),
            });
          }
          if (upstreamError.kind === 'invalid_tool_call') {
            log.warn(formatAntigravityUpstreamError(rawText));
          }
          const errorText = humanErrorMessage(upstreamError.kind);
          messages.push({
            type: 'error',
            catId,
            error: errorText,
            errorCode,
            metadata: { ...metadata, upstreamError },
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
