import { estimateTokens } from '../../../utils/token-counter.js';

export const WATCHER_TOOL_RESULT_TOKENS = 800;
/** Launch reserve only. Every real continuation is independently fenced by watcher-request-boundary. */
export const WATCHER_TURN_RESERVE_TOKENS = 4096;

export function boundedWatcherResult(value: unknown, callId: string): string {
  const serialized = JSON.stringify(value);
  if (estimateTokens(serialized) <= WATCHER_TOOL_RESULT_TOKENS) return serialized;
  let end = Math.min(serialized.length, 2400);
  let output: string;
  do {
    if (end > 0 && /[\uD800-\uDBFF]/u.test(serialized[end - 1]!)) end--;
    output = JSON.stringify({
      bounded: true,
      callId,
      excerpt: serialized.slice(0, end),
      continuation: '完整回执已保存到本轮轨迹；需要更多原文请缩小读取范围。写入可能已成功，保留原幂等标识核对。',
    });
    end = Math.floor(end * 0.8);
  } while (estimateTokens(output) > WATCHER_TOOL_RESULT_TOKENS);
  return output;
}
