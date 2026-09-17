import type { A2ADispatchDispositionService } from '../../../../ball-custody/A2ADispatchDispositionService.js';
import type { IInvocationRecordStore } from '../../stores/ports/InvocationRecordStore.js';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';

export interface StartupCustodyLog {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface StartupCustodyDeps {
  messageStore: IMessageStore;
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
  /** Reuses the live Queue preflight to fence a source already superseded in Ball custody. */
  a2aDispatchDispositionService?: Pick<A2ADispatchDispositionService, 'inspectHandoff'>;
  invocationQueue: InvocationQueue;
  log: StartupCustodyLog;
  now?: () => number;
}

export interface QueueCustodyResumeScope {
  threadId: string;
  userId: string;
}

export interface QueueCustodyStartupResult {
  entriesRestored: number;
  messagesBackfilled: number;
  messagesTerminalized: number;
  messagesFailed: number;
  handledTargets: number;
  failedTargets: number;
  resumeScopes: QueueCustodyResumeScope[];
  /** Restart-stable exact groups that must finish retirement before normal Queue resume. */
  prestartRetirements: QueueEntry[][];
  /** Pre-custody agent handoffs retain their legacy visibility recovery path. */
  legacyVisibilityFallbackMessageIds: string[];
}

export interface ReconciledMessage {
  message: StoredMessage;
  terminalized: boolean;
  handledTargets: number;
  failedTargets: number;
  /** The replacement fence could not establish truth, so startup must not resume this carrier. */
  recoveryDeferred?: boolean;
}
