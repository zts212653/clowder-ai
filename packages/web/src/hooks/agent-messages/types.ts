import type {
  A2ARoutingProjection,
  CliDiagnostics,
  LifecycleActiveRun,
  ProviderSemanticEvent,
  ReplyPreview,
} from '@cat-cafe/shared';
import type { NamedMessageStore } from '@/hooks/named-message-writer';
import type { ChatMessage, ChatMessageMetadata, SystemInfoProjection, TokenUsage } from '@/stores/chat-types';
import type { ChatState } from '@/stores/chatStore';

/** Provider/model footer data an event carries for the message it names. */
export interface AgentEventMetadata {
  provider: string;
  model: string;
  sessionId?: string;
  usage?: TokenUsage;
  diagnostics?: Record<string, unknown>;
  subexecutionEvents?: ChatMessageMetadata['subexecutionEvents'];
  /** F212 Phase B: structured CLI error diagnostics stamped by api providers. */
  cliDiagnostics?: CliDiagnostics;
}

type TurnExecutionProjection = NonNullable<NonNullable<ChatMessage['extra']>['turnExecution']>;

export interface AgentEventExtra {
  crossPost?: { sourceThreadId: string; sourceInvocationId?: string };
  a2aRouting?: { fromCatId?: string; targetCatId?: string; invocationId?: string; routing?: A2ARoutingProjection };
  /** #814: the event is an explicit post_message — always its own message. */
  isExplicitPost?: boolean;
  /** F098-C1: explicit target cats from post_message (direction pills). */
  targetCats?: string[];
  /** Durable child identity projected onto the response before history hydration. */
  turnExecution?: TurnExecutionProjection;
  /** Bodyless child executions that assisted the visible child. */
  auxiliaryTurnExecutions?: TurnExecutionProjection[];
}

/**
 * One `agent_message` socket event. `messageId` names the stored message the event writes to:
 * the turn's response (the server stamps it on every event of an admitted turn) or a post's
 * own record. An event without `messageId` is status-only and never writes a bubble.
 */
export interface AgentEventFields {
  type: string;
  catId: string;
  semanticEvent?: ProviderSemanticEvent;
  content?: string;
  textMode?: 'append' | 'replace';
  error?: string;
  /** Structured backend/provider error code. Some provider errors are recoverable mid-run. */
  errorCode?: string;
  isFinal?: boolean;
  metadata?: AgentEventMetadata;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** stream = the turn's own output; callback = a post_message with its own stored id. */
  origin?: 'stream' | 'callback';
  messageId?: string;
  /** Machine-readable A2A target cat for handoff events. */
  targetCatId?: string;
  routing?: A2ARoutingProjection;
  mentionsUser?: boolean;
  extra?: AgentEventExtra;
  replyTo?: string;
  replyPreview?: ReplyPreview;
  /** Chain (parent) invocation id: liveness, queue, cancel and slot scope. */
  invocationId?: string;
  /** Per-cat turn id. */
  turnInvocationId?: string;
  /** Wire compatibility only: the response is addressed by `messageId`. */
  lifecycleResponseMessageId?: string;
  /** Server-owned working identity; never synthesized client-side. */
  activeRun?: LifecycleActiveRun;
  /** F183 Phase C: thread-scoped monotonic sequence number. */
  seq?: number;
  /** F183 Phase C: server sequencer epoch; a change means the server restarted. */
  seqEpoch?: string;
}

/** Open-thread entry: threadId may be absent on malformed/legacy events (then the open thread). */
export interface AgentMsg extends AgentEventFields {
  threadId?: string;
  timestamp?: number;
}

export interface BackgroundAgentMessage extends AgentEventFields {
  threadId: string;
  timestamp: number;
}

export interface BackgroundToastInput {
  type: 'success' | 'error';
  title: string;
  message: string;
  threadId: string;
  duration: number;
}

/** Thread-scoped store surface the background entry needs (the writer's plus status/slots). */
export type BackgroundStoreLike = NamedMessageStore &
  Pick<
    ChatState,
    | 'removeThreadMessage'
    | 'setThreadCatInvocation'
    | 'setThreadLoading'
    | 'setThreadHasActiveInvocation'
    | 'addThreadActiveInvocation'
    | 'removeThreadActiveInvocation'
    | 'updateThreadCatStatus'
    | 'replaceThreadTargetCats'
  >;

export interface HandleBackgroundMessageOptions {
  store: BackgroundStoreLike;
  /** Counter for ids of system rows and tool events this client creates (never message identity). */
  nextBgSeq: () => number;
  addToast: (toast: BackgroundToastInput) => void;
  /** Human-facing projection only; stored events keep their stable catId facts. */
  resolveCatName?: (catId: string) => string;
  /** #80 fix-C: clear the done-timeout guard when a background thread completes. */
}

export interface SystemInfoConsumeResult {
  consumed: boolean;
  content: string;
  variant: 'info' | 'a2a_followup';
  systemInfo?: SystemInfoProjection;
}
