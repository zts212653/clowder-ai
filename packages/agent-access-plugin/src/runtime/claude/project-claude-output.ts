import { addAbortSignal, type Readable } from 'node:stream';
import type { CatId } from '@cat-cafe/shared';
import { agentAccessClaudeFrameSchema } from '@clowder-ai/agent-contract/claude';
import { extractClaudeUsage, transformClaudeEvent } from './claude-ndjson-parser.js';

export function createClaudeOutputProjection(catId: CatId) {
  const state = {
    currentMessageId: undefined as string | undefined,
    partialTextMessageIds: new Set<string>(),
    lastTurnInputTokens: undefined as number | undefined,
    thinkingBuffer: '',
  };
  return (event: unknown) => {
    const data = event as Record<string, unknown> | null | undefined;
    const usage = data?.type === 'result' ? extractClaudeUsage(data) : undefined;
    if (usage && state.lastTurnInputTokens !== undefined) usage.lastTurnInputTokens = state.lastTurnInputTokens;
    return { messages: transformClaudeEvent(event, catId, state), usage };
  };
}

export async function* projectClaudeOutput(input: { catId: CatId; source: Readable; signal: AbortSignal }) {
  const source = addAbortSignal(input.signal, input.source);
  const project = createClaudeOutputProjection(input.catId);
  for await (const input of source) {
    const { sequence, event } = agentAccessClaudeFrameSchema.parse(input);
    yield { sequence, ...project(event) };
  }
}
