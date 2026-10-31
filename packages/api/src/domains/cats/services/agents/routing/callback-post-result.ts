/**
 * #573: a post_message callback is its own durable message. The route only needs to
 * know whether a post was confirmed (and its id), never to fold it into the final.
 */
export type CallbackPostResult = {
  confirmed: boolean;
  messageId?: string;
  threadId?: string;
};

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

export class CallbackPostTracker {
  private _postConfirmed = false;
  private _postMessageId: string | undefined;

  constructor(private readonly recordPersistedMessageId: (messageId: string) => void) {}

  get postConfirmed(): boolean {
    return this._postConfirmed;
  }

  get postMessageId(): string | undefined {
    return this._postMessageId;
  }

  recordConfirmedPost(result: CallbackPostResult): void {
    if (!result.confirmed) return;
    this._postConfirmed = true;
    if (result.messageId) {
      this._postMessageId = result.messageId;
      this.recordPersistedMessageId(result.messageId);
    }
  }

  reset(): void {
    this._postConfirmed = false;
    this._postMessageId = undefined;
  }
}
