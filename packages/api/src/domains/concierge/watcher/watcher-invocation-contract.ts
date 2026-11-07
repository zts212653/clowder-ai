import type { SessionRecord, TurnExecutionRecord, WatcherSessionState } from '@cat-cafe/shared';
import type { InvocationRegistry } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import type { TranscriptWriter } from '../../cats/services/session/TranscriptWriter.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { AgentService, ProviderRequestGenerationCommitV1 } from '../../cats/services/types.js';
import type { WatcherCheckpointOwners } from './watcher-checkpoint.js';
import type { createWatcherRequestBoundary } from './watcher-request-boundary.js';

/** Shared owner and run shapes must not depend on the functions which consume them. */
export interface WatcherInvocationOwners extends WatcherCheckpointOwners {
  registry: InvocationRegistry;
  messages: IMessageStore;
  threads: IThreadStore;
  transcript: TranscriptWriter;
  apiUrl: string;
  maySpeak(userId: string, threadId: string, catId: string): Promise<boolean>;
  now?(): number;
}

export interface WatcherInvocationInput {
  session: SessionRecord;
  source: TurnExecutionRecord;
  service: AgentService;
  quiet: boolean;
  signal?: AbortSignal;
  deadlineMs?: number;
  recoveryOnly?: boolean;
}

export interface WatcherRunState {
  session: SessionRecord;
  state: WatcherSessionState;
  prefixTokens: number;
  committed: boolean;
  nativeTurnAdmitted?: boolean;
  recoveredIdle?: boolean;
  boundary?: Awaited<ReturnType<typeof createWatcherRequestBoundary>>;
  generation?: ProviderRequestGenerationCommitV1;
}
