import type {
  CatInvocationInfo,
  CatStatusType,
  ChatMessage,
  ChatMessageMetadata,
  ChatMessagePatch,
  RichBlock,
  ThreadState,
  TokenUsage,
  ToolEvent,
} from '@/stores/chat-types';

export interface BackgroundAgentMessage {
  type: string;
  catId: string;
  threadId: string;
  content?: string;
  messageId?: string;
  origin?: 'stream' | 'callback';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  error?: string;
  isFinal?: boolean;
  metadata?: { provider: string; model: string; sessionId?: string; usage?: TokenUsage };
  /** F52: Cross-thread origin metadata */
  extra?: { crossPost?: { sourceThreadId: string; sourceInvocationId?: string } };
  /** F057-C2: Whether this message mentions the user (@user / @铲屎官) */
  mentionsUser?: boolean;
  /** F121: Reply-to message ID */
  replyTo?: string;
  /** F121: Server-hydrated reply preview */
  replyPreview?: { senderCatId: string | null; content: string; deleted?: true };
  /** F108: Invocation ID — distinguishes messages from concurrent invocations */
  invocationId?: string;
  timestamp: number;
}

export interface BackgroundStreamRef {
  id: string;
  threadId: string;
  catId: string;
}

export interface BackgroundToastInput {
  type: 'success' | 'error';
  title: string;
  message: string;
  threadId: string;
  duration: number;
}

export interface BackgroundStoreLike {
  addMessageToThread: (threadId: string, msg: ChatMessage) => void;
  removeThreadMessage: (threadId: string, messageId: string) => void;
  appendToThreadMessage: (threadId: string, messageId: string, content: string) => void;
  appendToolEventToThread: (threadId: string, messageId: string, event: ToolEvent) => void;
  /** F22: Append a rich block to a message in a specific thread */
  appendRichBlockToThread: (threadId: string, messageId: string, block: RichBlock) => void;
  setThreadCatInvocation: (threadId: string, catId: string, info: Partial<CatInvocationInfo>) => void;
  setThreadMessageMetadata: (threadId: string, messageId: string, metadata: ChatMessageMetadata) => void;
  setThreadMessageUsage: (threadId: string, messageId: string, usage: TokenUsage) => void;
  /** F045: Set or append extended thinking on an assistant message in a background thread */
  setThreadMessageThinking: (threadId: string, messageId: string, thinking: string) => void;
  /** F081: Persist stream invocation identity on background assistant bubbles */
  setThreadMessageStreamInvocation: (threadId: string, messageId: string, invocationId: string) => void;
  setThreadMessageStreaming: (threadId: string, messageId: string, streaming: boolean) => void;
  setThreadLoading: (threadId: string, loading: boolean) => void;
  setThreadHasActiveInvocation: (threadId: string, active: boolean) => void;
  /** F108: Add an active invocation slot to a thread */
  addThreadActiveInvocation: (threadId: string, invocationId: string, catId: string, mode: string) => void;
  /** F108: Remove an active invocation slot from a thread */
  removeThreadActiveInvocation: (threadId: string, invocationId: string) => void;
  updateThreadCatStatus: (threadId: string, catId: string, status: CatStatusType) => void;
  /** Batch content-append + metadata + streaming + catStatus into one set(). */
  batchStreamChunkUpdate: (params: {
    threadId: string;
    messageId: string;
    catId: string;
    content: string;
    metadata?: ChatMessageMetadata;
    streaming: boolean;
    catStatus: CatStatusType;
  }) => void;
  clearThreadActiveInvocation: (threadId: string) => void;
  getThreadState: (threadId: string) => ThreadState;
  replaceThreadTargetCats: (threadId: string, cats: string[]) => void;
  replaceThreadMessageId: (threadId: string, fromId: string, toId: string) => void;
  patchThreadMessage: (threadId: string, messageId: string, patch: ChatMessagePatch) => void;
}

export interface HandleBackgroundMessageOptions {
  store: BackgroundStoreLike;
  bgStreamRefs: Map<string, BackgroundStreamRef>;
  replacedInvocations: Map<string, string>;
  nextBgSeq: () => number;
  addToast: (toast: BackgroundToastInput) => void;
  /** #80 fix-C: Clear the done-timeout guard when a background thread completes */
  clearDoneTimeout?: (threadId?: string) => void;
  /** #586 follow-up: Just-finalized stream bubble IDs keyed by streamKey */
  finalizedBgRefs: Map<string, string>;
}

export type ActiveRoutedAgentMessage = {
  type: string;
  catId: string;
  threadId?: string;
  isFinal?: boolean;
};
