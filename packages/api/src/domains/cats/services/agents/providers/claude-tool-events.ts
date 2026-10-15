import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage } from '../../types.js';

interface ToolFacts {
  name: string;
  input: Record<string, unknown>;
  rawInput?: unknown;
}
export interface ClaudeStreamState {
  currentMessageId: string | undefined;
  partialTextMessageIds: Set<string>;
  lastTurnInputTokens: number | undefined;
  thinkingBuffer: string;
  toolState?: { calls: Map<string, ToolFacts>; completed: Set<string> };
}
function toolState(state: ClaudeStreamState) {
  state.toolState ??= { calls: new Map(), completed: new Set() };
  return state.toolState;
}
function parentId(event: Record<string, unknown>): string | undefined {
  return typeof event.parent_tool_use_id === 'string' && event.parent_tool_use_id.length > 0
    ? event.parent_tool_use_id
    : undefined;
}
function pairKey(id: string, parent: string | undefined): string {
  return JSON.stringify([parent ?? null, id]);
}
export function resetClaudeToolState(state: ClaudeStreamState): void {
  state.toolState = undefined;
}
export function claudeToolUse(
  block: Record<string, unknown>,
  event: Record<string, unknown>,
  catId: CatId,
  state: ClaudeStreamState,
): AgentMessage | null {
  if (typeof block.name !== 'string') return null;
  const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : undefined;
  const parent = parentId(event);
  const input =
    typeof block.input === 'object' && block.input !== null && !Array.isArray(block.input)
      ? (block.input as Record<string, unknown>)
      : {};
  if (id) {
    const tools = toolState(state);
    const key = pairKey(id, parent);
    if (tools.calls.has(key) || tools.completed.has(key)) return null;
    tools.calls.set(key, { name: block.name, input, rawInput: block.input });
  }
  return {
    type: 'tool_use',
    catId,
    toolName: block.name,
    toolInput: input,
    timestamp: Date.now(),
    ...(id ? { toolUseId: id } : {}),
    ...(parent ? { toolParentUseId: parent } : {}),
    ...(block.input !== undefined ? { toolRawPayload: { rawInput: block.input } } : {}),
  };
}
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);
  return (content as unknown[])
    .map((block) => {
      if (typeof block === 'object' && block !== null) {
        const value = block as Record<string, unknown>;
        if (value.type === 'text' && typeof value.text === 'string') return value.text;
      }
      return JSON.stringify(block);
    })
    .join('\n');
}
/** A native tool_result's absent is_error has the SDK's default success meaning. */
export function claudeToolResults(
  event: Record<string, unknown>,
  catId: CatId,
  state: ClaudeStreamState,
): AgentMessage[] | null {
  const message = event.message as Record<string, unknown> | undefined;
  if (!Array.isArray(message?.content)) return null;
  const parent = parentId(event);
  const tools = toolState(state);
  const results: AgentMessage[] = [];
  for (const value of message.content) {
    if (typeof value !== 'object' || value === null) continue;
    const block = value as Record<string, unknown>;
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || !block.tool_use_id) continue;
    const id = block.tool_use_id;
    const key = pairKey(id, parent);
    if (tools.completed.has(key)) continue;
    const facts = tools.calls.get(key);
    results.push({
      type: 'tool_result',
      catId,
      toolUseId: id,
      timestamp: Date.now(),
      ...(parent ? { toolParentUseId: parent } : {}),
      ...(facts ? { toolName: facts.name, toolInput: facts.input } : {}),
      toolResultStatus:
        block.is_error === true ? 'error' : block.is_error === false || block.is_error === undefined ? 'ok' : 'unknown',
      content: resultText(block.content),
      toolRawPayload: {
        ...(facts?.rawInput !== undefined ? { rawInput: facts.rawInput } : {}),
        ...(block.content !== undefined ? { rawOutput: block.content, content: block.content } : {}),
      },
    });
    tools.completed.add(key);
    tools.calls.delete(key);
  }
  return results.length ? results : null;
}
