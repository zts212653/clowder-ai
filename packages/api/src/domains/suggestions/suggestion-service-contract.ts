import type { SuggestionByline, SuggestionView } from '@cat-cafe/shared';
import type { ISuggestionStore } from './SuggestionStore.js';
import type { SuggestionActionRegistry } from './suggestion-actions.js';

export interface SuggestionActor {
  userId: string;
  threadId: string;
  catId: string;
  invocationId?: string;
  parentInvocationId?: string;
  byline?: SuggestionByline;
}

export interface SuggestionServiceDeps {
  watcherOutputFence?(
    actor: SuggestionActor,
  ): Promise<import('../concierge/watcher/watcher-output-fence.js').WatcherOutputFence | null>;
  store: ISuggestionStore;
  registry: SuggestionActionRegistry;
  /** Looks up a message the row should hang under; null when it does not exist. */
  loadMessage(messageId: string): Promise<{ userId: string; threadId: string } | null>;
  /** The message id this turn's reply will be saved under. */
  resolveTurnMessageId?(actor: SuggestionActor): string | undefined;
  publish?(threadId: string, view: SuggestionView): void;
  now?: () => number;
  newId?: () => string;
}

export type SuggestionFailureCode =
  | 'invalid'
  | 'unknown_kind'
  | 'kind_stopped'
  | 'message_not_found'
  | 'message_taken'
  | 'not_found'
  | 'conflict'
  | 'action_failed'
  /** The action did part of the work and could not take it back; the row now says what was done. */
  | 'action_partial';

export type SuggestionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SuggestionFailureCode; error: string; view?: SuggestionView };
