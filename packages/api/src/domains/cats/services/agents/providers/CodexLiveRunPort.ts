import type { CodexAppServerJsonObject } from './CodexAppServerEventMapper.js';
import type { CodexAppServerNativeRpcClient } from './CodexAppServerNativeRpc.js';
import type { CodexSubexecutionEvent } from './CodexSubexecutionIdentity.js';

/** Host Stop before the initial request is accepted must not look like a successful run. */
export class CodexLiveStartupCancelledError extends Error {
  readonly code = 'INVOCATION_CANCELLED' as const;

  constructor() {
    super('Live call ended before the initial native turn');
    this.name = 'CodexLiveStartupCancelledError';
  }
}

export type CodexLiveContextKind =
  | 'meeting_context'
  | 'recovery_context'
  | 'page_action_result'
  | 'owner_voice_context'
  | 'late_result_notice';

export interface CodexLiveNativeClient extends CodexAppServerNativeRpcClient {
  submitText(text: string, sourceMessageId: string): Promise<string>;
  /** Only callable while the native notification loop owns a verified safe boundary. */
  submitContextAtBoundary?(
    text: string,
    sourceRefs: readonly string[],
    contextKind: CodexLiveContextKind,
    signal: AbortSignal,
    authorize: () => Promise<boolean>,
    clientUserMessageId?: string,
  ): Promise<string>;
  wakeBoundary?(): void;
}

/** Host-owned control port, never constructed from model arguments or raw HTTP config. */
export interface CodexLiveRunPort {
  /** Synchronous Host revocation; preparing alone does not abort this lifetime. */
  readonly startupSignal?: AbortSignal;
  /** The surface's existing grant, projected into both sides of the same cat's duty context. */
  readonly householdToolsEnabled?: boolean;
  /** Host-resolved composition facts; neither renderer input nor a substitute execution identity. */
  readonly compositionInstructions?: string;
  /** Stops new queued inputs before transport teardown finishes. */
  acceptsInput?(): boolean;
  /** Exact server-owned invocation binding; a surface/exposure callback alone grants no result consumption. */
  isActiveCarrier?(query: { invocationId: string; catId: string; threadId: string }): boolean;
  /** Bind to credentials minted by the ordinary Host invocation before configuring native MCP. */
  configure?(callbackEnv: Record<string, string>): Promise<CodexAppServerJsonObject>;
  /** Surface teardown when the enclosing normal invocation exits or fails before readiness. */
  fail?(error: Error): Promise<void>;
  /** Resolve only after Realtime is stopped and its active native turn is terminal. */
  readonly finished: Promise<void>;
  /** The original Host prompt has reached a bound native thread before this callback. */
  ready(threadId: string, client: CodexLiveNativeClient): Promise<void>;
  /** Exact native events drive credential projections and segment receipts, not a new task ledger. */
  observe(message: CodexAppServerJsonObject): Promise<void>;
  /** Only F306-admitted child facts, never raw child finals through the root event path. */
  observeSubexecution?(event: CodexSubexecutionEvent): Promise<void>;
  observeHostAcquisition?(mode: 'cold' | 'warm'): void;
  hasPendingInboxWake?(): boolean;
  /** Only a Host-owned settled page receipt can request a wake while its native turn is active. */
  hasPendingPageResultWake?(): boolean;
  /** A Host-persisted current owner utterance may update active deep work; it cannot start new work. */
  hasPendingOwnerVoiceWake?(): boolean;
  onSafeBoundary?(kind: 'idle' | 'tool_complete' | 'turn_complete'): Promise<void>;
}

/** Spoken segments are persisted by the Live surface; deep drafts must not also become one giant Chat reply. */
export function isLiveDraftEvent(event: CodexAppServerJsonObject): boolean {
  const item = event.item as CodexAppServerJsonObject | undefined;
  return event.type === 'turn.completed' || item?.type === 'agent_message' || item?.type === 'reasoning';
}
