import type { RichBlock } from '@cat-cafe/shared';
import type { StoredToolEvent, StreamMetadataAugmentInput } from '../../stores/ports/MessageStore.js';
import type { MessageMetadata } from '../../types.js';
import { renderThinkingChunks } from './thinking-chunks.js';

export type CallbackStreamDisposition = 'independent' | 'replace_final';

export type CallbackPostResult = {
  confirmed: boolean;
  messageId?: string;
  threadId?: string;
};

export function readCallbackStreamDisposition(input: unknown): CallbackStreamDisposition {
  let parsed: { streamDisposition?: unknown } | undefined;
  if (input && typeof input === 'object') {
    parsed = input as { streamDisposition?: unknown };
  } else if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input) as { streamDisposition?: unknown };
    } catch {
      // Invalid tool input cannot explicitly opt into replacing the final.
    }
  }
  return parsed?.streamDisposition === 'replace_final' ? 'replace_final' : 'independent';
}

function collectCallbackPostResultCandidates(content: string): string[] {
  const candidates = new Set<string>();
  const trimmed = content.trim();
  if (trimmed) candidates.add(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) candidates.add(candidate);
  }
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart > 0) candidates.add(trimmed.slice(jsonStart));
  return [...candidates];
}

function callbackPostResultFromPayload(parsed: {
  status?: unknown;
  messageId?: unknown;
  threadId?: unknown;
}): CallbackPostResult | null {
  const messageId = typeof parsed.messageId === 'string' && parsed.messageId.length > 0 ? parsed.messageId : undefined;
  const confirmed =
    parsed.status === 'ok' ||
    parsed.status === 'duplicate' ||
    (parsed.status === 'terminal_ack_recorded' && messageId !== undefined);
  if (!confirmed && parsed.status === undefined) return null;
  return {
    confirmed,
    ...(messageId ? { messageId } : {}),
    ...(typeof parsed.threadId === 'string' && parsed.threadId.length > 0 ? { threadId: parsed.threadId } : {}),
  };
}

export function parseCallbackPostResult(content: string | undefined): CallbackPostResult {
  if (!content) return { confirmed: false };
  for (const candidate of collectCallbackPostResultCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as { status?: unknown; messageId?: unknown; threadId?: unknown };
      const result = callbackPostResultFromPayload(parsed);
      if (result) return result;
    } catch {
      // Try the next candidate shape.
    }
  }

  return {
    confirmed:
      /"status"\s*:\s*"(ok|duplicate)"/.test(content) ||
      (/"status"\s*:\s*"terminal_ack_recorded"/.test(content) && /"messageId"\s*:\s*"[^"]+"/.test(content)),
  };
}

export class CallbackFinalReplacementTracker {
  private _postConfirmed = false;
  private _postMessageId: string | undefined;
  private _finalReplacementConfirmed = false;
  private _finalReplacementMessageId: string | undefined;

  constructor(private readonly recordPersistedMessageId: (messageId: string) => void) {}

  get postConfirmed(): boolean {
    return this._postConfirmed;
  }

  get postMessageId(): string | undefined {
    return this._postMessageId;
  }

  get finalReplacementConfirmed(): boolean {
    return this._finalReplacementConfirmed;
  }

  get finalReplacementMessageId(): string | undefined {
    return this._finalReplacementMessageId;
  }

  recordConfirmedPost(disposition: CallbackStreamDisposition, result: CallbackPostResult): void {
    if (!result.confirmed) return;
    this._postConfirmed = true;
    if (result.messageId) {
      this._postMessageId = result.messageId;
      this.recordPersistedMessageId(result.messageId);
    }
    if (disposition === 'replace_final' && result.messageId) {
      this._finalReplacementConfirmed = true;
      this._finalReplacementMessageId = result.messageId;
    }
  }

  reset(): void {
    this._postConfirmed = false;
    this._postMessageId = undefined;
    this._finalReplacementConfirmed = false;
    this._finalReplacementMessageId = undefined;
  }
}

type CallbackFinalReplacementMetadataInput = {
  thinkingChunks: readonly string[];
  metadata?: MessageMetadata;
  toolEvents: readonly StoredToolEvent[];
  replyTo?: string;
  mentionsUser: boolean;
  richBlocks: readonly RichBlock[];
  visibleTurnInvocationId?: string;
  persistedInvocationId?: string;
  turnTriggerMessageId?: string;
  tracing?: NonNullable<StreamMetadataAugmentInput['extra']>['tracing'];
  executionProjections: NonNullable<StreamMetadataAugmentInput['extra']>;
};

export function buildCallbackFinalReplacementMetadataPatch({
  thinkingChunks,
  metadata,
  toolEvents,
  replyTo,
  mentionsUser,
  richBlocks,
  visibleTurnInvocationId,
  persistedInvocationId,
  turnTriggerMessageId,
  tracing,
  executionProjections,
}: CallbackFinalReplacementMetadataInput): StreamMetadataAugmentInput {
  const patch: StreamMetadataAugmentInput = {};
  if (thinkingChunks.length > 0) patch.thinking = renderThinkingChunks(thinkingChunks);
  if (metadata) patch.metadata = metadata;
  if (toolEvents.length > 0) patch.toolEvents = toolEvents;
  if (replyTo) patch.replyTo = replyTo;
  if (mentionsUser) patch.mentionsUser = true;

  const extra: NonNullable<StreamMetadataAugmentInput['extra']> = { ...executionProjections };
  if (richBlocks.length > 0) extra.rich = { v: 1, blocks: [...richBlocks] };
  if (persistedInvocationId) {
    extra.stream = {
      invocationId: persistedInvocationId,
      turnInvocationId: visibleTurnInvocationId ?? persistedInvocationId,
    };
  }
  if (turnTriggerMessageId) {
    extra.causal = { kind: 'invocation_reply', triggerMessageId: turnTriggerMessageId };
  }
  if (tracing) extra.tracing = tracing;
  if (Object.keys(extra).length > 0) patch.extra = extra;
  return patch;
}

export function hasCallbackFinalReplacementMetadata(patch: StreamMetadataAugmentInput): boolean {
  return Boolean(
    patch.thinking || patch.metadata || patch.toolEvents?.length || patch.replyTo || patch.mentionsUser || patch.extra,
  );
}
