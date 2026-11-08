import type { TurnExecutionRecord, WatcherSessionState } from '@cat-cafe/shared';
import { estimateTokens } from '../../../../utils/token-counter.js';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import { awaitStoreRead } from '../../../cats/services/stores/ports/StoreReadOptions.js';
import { watcherRawWindow } from '../watcher-prompt.js';
import { nextWatcherWindowTokens } from './watcher-budget-progress.js';
import { WATCHER_TURN_RESERVE_TOKENS } from './watcher-context-budget.js';

/** Original text is sliced by its existing reader; native continuation budgets are checked separately. */
export async function watcherWindow(
  messages: IMessageStore,
  source: TurnExecutionRecord,
  state: WatcherSessionState,
  instructions: string,
  tools: readonly { name: string; description?: string; inputSchema: unknown }[],
  signal?: AbortSignal,
) {
  const fixedPrefix =
    estimateTokens(
      JSON.stringify(
        tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        })),
      ),
    ) +
    estimateTokens(instructions) +
    estimateTokens(state.notes) +
    1024;
  const tokenBudget = Math.min(nextWatcherWindowTokens(state), 30_000 - WATCHER_TURN_RESERVE_TOKENS - fixedPrefix);
  if (tokenBudget < 128) throw new Error('watcher_tool_surface_exceeds_context_budget');
  const raw = await awaitStoreRead(
    watcherRawWindow(
      messages,
      source.userId,
      source.threadId,
      state,
      source.responseSettlement?.kind === 'message' ? source.responseSettlement.messageId : undefined,
      source.responseSettlement?.settledAt,
      tokenBudget,
      signal,
    ),
    { signal },
  );
  return { ...raw, tokenBudget };
}
