/** Native output identity is separate from a canonical stored message's messageId. */
export interface OutputMessageIdentity {
  provider: string;
  runtimeSessionId: string;
  turnId: string;
  nativeId: string;
}

export type OutputMessageChannel = 'analysis' | 'commentary' | 'final';

/** Optional observations: missing native facts must never be reconstructed from prose. */
export interface ProviderOutputMessage {
  provider: string;
  runtimeSessionId?: string;
  turnId?: string;
  nativeId?: string;
  channel?: OutputMessageChannel | 'unknown';
  complete?: boolean;
  /** Application within this native message only; independent from Chat's whole-turn textMode. */
  textMode?: 'append' | 'replace';
  /** Adapter-added paragraph separator, not part of this native message's text. */
  displayPrefixLength?: 2;
}

export interface AssistantOutputSource {
  sessionId: string;
  invocationId: string;
  /** Inclusive canonical eventNo range, readable with the existing invocation/raw cursors. */
  firstEventNo: number;
  lastEventNo: number;
  eventCount: number;
}

/** The earliest assistant candidate stays fixed even when it is unavailable. */
export type FirstAssistantOutputEvidence = {
  role: 'assistant';
  /** Native message completion, not a claim that the text is a grammatical sentence. */
  complete: boolean;
  source: AssistantOutputSource;
  byteLength: number;
} & (
  | { status: 'available'; identity: OutputMessageIdentity; channel: OutputMessageChannel; content: string }
  | {
      status: 'unknown_identity' | 'unknown_channel' | 'incomplete' | 'conflict' | 'oversized';
      identity?: OutputMessageIdentity;
      channel?: OutputMessageChannel;
      content?: never;
    }
);

export const MAX_FIRST_ASSISTANT_OUTPUT_BYTES = 4096;

/** Reject invalid IDs instead of trimming two native identities into one. */
export function readOutputMessageIdentity(value: unknown): OutputMessageIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const keys = ['provider', 'runtimeSessionId', 'turnId', 'nativeId'] as const;
  if (
    keys.some(
      (key) =>
        typeof record[key] !== 'string' ||
        !record[key] ||
        record[key].trim() !== record[key] ||
        record[key].length > 256,
    )
  )
    return undefined;
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as OutputMessageIdentity;
}

export function readOutputMessageChannel(value: unknown): OutputMessageChannel | undefined {
  return value === 'analysis' || value === 'commentary' || value === 'final' ? value : undefined;
}

export function sameOutputMessageIdentity(a: OutputMessageIdentity, b: OutputMessageIdentity): boolean {
  return (
    a.provider === b.provider &&
    a.runtimeSessionId === b.runtimeSessionId &&
    a.turnId === b.turnId &&
    a.nativeId === b.nativeId
  );
}
