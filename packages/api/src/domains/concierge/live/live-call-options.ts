import type { CompanionIdentitySnapshotV1 } from '@cat-cafe/shared';
import type { CodexAppServerJsonObject } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { LivePageActionApprovalLedger } from './host/live-page-action-approval-ledger.js';
import type { LivePageActionAuthorityDeps } from './host/live-page-action-authority.js';
import type { LiveInboxReference, LiveInboxScope, LiveInboxSource } from './inbox/live-inbox-contract.js';
import type { LiveCompanionSelection } from './live-companion-selection.js';
import type { LiveTranscriptBinding } from './live-transcript.js';
import type { LiveRecoveryOptions } from './recovery/live-recovery-contract.js';

/** Admission dependencies owned by Host, never a renderer-supplied configuration. */
export interface LiveCompanionCallOptions {
  binding: Omit<LiveTranscriptBinding, 'nativeThreadId' | 'realtimeSessionId'>;
  messageStore: Pick<IMessageStore, 'appendIdempotent'>;
  mcpDistDir: string;
  allowedDirectories: readonly string[];
  screenServer?: CodexAppServerJsonObject;
  desktopRoot?: string;
  householdToolsEnabled?: boolean;
  companion?: LiveCompanionSelection;
  /** Immutable Host selection at prepare, reused for every committed voice/result message. */
  identitySnapshot?: CompanionIdentitySnapshotV1;
  verifyCompanion?(): Promise<boolean>;
  /** Read only the already-owned conversation; failure must not masquerade as recovered context. */
  loadConversation?(): Promise<string>;
  /** Confirm the ordinary pipeline has already committed the native session binding. */
  verifyNativeBinding(nativeThreadId: string): Promise<boolean>;
  publish(message: StoredMessage): void;
  inbox?: {
    source(
      scope: LiveInboxScope,
      authorize: (scope: LiveInboxScope) => Promise<boolean>,
      isSameCallExposure: (message: StoredMessage) => boolean,
    ): LiveInboxSource;
    onSuccessorRequired(scope: LiveInboxScope, references: readonly LiveInboxReference[]): Promise<void>;
  };
  /** Canonical read ports; the Host supplies the call and current-thread authority. */
  recovery?: Omit<LiveRecoveryOptions, 'inbox'>;
  reportInboxFailure?(error: unknown): void;
  /** Installed only with a separately verified owner approval ledger and named page policy. */
  pageAction?: Pick<LivePageActionAuthorityDeps, 'messages' | 'isCurrentThread'> & {
    approvalLedger: LivePageActionApprovalLedger;
  };
}
