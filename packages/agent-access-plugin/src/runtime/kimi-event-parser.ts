/**
 * Kimi CLI stream-json event parsing utilities
 *
 * Extracts text, thinking content, tool calls, usage stats, and session IDs
 * from the Kimi CLI `--output-format stream-json` output.
 */

export interface KimiPrintMessage {
  role?: string;
  content?: unknown;
  thinking?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  thought?: unknown;
  tool_calls?: unknown[];
  usage?: unknown;
  stats?: unknown;
  session_id?: string;
  sessionId?: string;
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw };
  }
}

export function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(content)) return null;
  const text = content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const block = item as Record<string, unknown>;
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

export function extractThinkingContent(message: KimiPrintMessage): string | null {
  const candidates = [message.thinking, message.reasoning, message.reasoning_content, message.thought];
  for (const candidate of candidates) {
    const text = extractTextContent(candidate);
    if (text) return text;
  }
  if (Array.isArray(message.content)) {
    const thinkText = message.content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const block = item as Record<string, unknown>;
        if (typeof block.think === 'string') return block.think;
        if (typeof block.reasoning === 'string') return block.reasoning;
        if (block.type === 'thinking' && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (thinkText) return thinkText;
  }
  return null;
}

export function parseUsage(candidate: unknown) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const stats = candidate as Record<string, unknown>;
  const usage = {
    ...(typeof stats.total_tokens === 'number' ? { totalTokens: stats.total_tokens } : {}),
    ...(typeof stats.input_tokens === 'number' ? { inputTokens: stats.input_tokens } : {}),
    ...(typeof stats.output_tokens === 'number' ? { outputTokens: stats.output_tokens } : {}),
    ...(typeof stats.cached_input_tokens === 'number' ? { cacheReadTokens: stats.cached_input_tokens } : {}),
    ...(typeof stats.last_turn_input_tokens === 'number' ? { lastTurnInputTokens: stats.last_turn_input_tokens } : {}),
    ...(typeof stats.context_window === 'number' ? { contextWindowSize: stats.context_window } : {}),
    ...(typeof stats.context_used_tokens === 'number' ? { contextUsedTokens: stats.context_used_tokens } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

export function readSessionIdFromMessage(message: KimiPrintMessage): string | undefined {
  const values = [message.session_id, message.sessionId];
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}
