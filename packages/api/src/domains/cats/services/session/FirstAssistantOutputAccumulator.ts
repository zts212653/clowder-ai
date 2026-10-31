import {
  type FirstAssistantOutputEvidence,
  MAX_FIRST_ASSISTANT_OUTPUT_BYTES,
  type OutputMessageChannel,
  type OutputMessageIdentity,
  readOutputMessageChannel,
  readOutputMessageIdentity,
  sameOutputMessageIdentity,
} from '@cat-cafe/shared';
import type { TranscriptEvent } from './TranscriptReader.js';

type UnavailableStatus = Exclude<FirstAssistantOutputEvidence['status'], 'available' | 'oversized' | 'incomplete'>;
export interface AssistantOutputFragment {
  identity?: OutputMessageIdentity;
  channel?: OutputMessageChannel;
  unavailable?: UnavailableStatus;
  complete: boolean;
  mode?: 'append' | 'replace';
  byteLength: number;
  startsWithLowSurrogate?: boolean;
  endsWithHighSurrogate?: boolean;
  content?: string;
}

function outputContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return (value as unknown[])
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const record = part as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    })
    .join('\n');
}

function outputTextMode(
  event: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): AssistantOutputFragment['mode'] {
  const value =
    metadata && Object.hasOwn(metadata, 'textMode') && metadata.textMode !== undefined
      ? metadata.textMode
      : Object.hasOwn(event, 'textMode') && event.textMode !== undefined
        ? event.textMode
        : 'append';
  return value === 'append' || value === 'replace' ? value : undefined;
}

function outputObservation(event: Record<string, unknown>) {
  const metadata =
    event.outputMessage && typeof event.outputMessage === 'object'
      ? (event.outputMessage as Record<string, unknown>)
      : undefined;
  const identity = readOutputMessageIdentity(metadata);
  const channel = readOutputMessageChannel(metadata?.channel);
  const mode = outputTextMode(event, metadata);
  let content = outputContent(event.content);
  let unavailable: UnavailableStatus | undefined = !identity
    ? 'unknown_identity'
    : !channel
      ? 'unknown_channel'
      : undefined;
  if (mode === undefined) unavailable = 'conflict';
  if (metadata?.displayPrefixLength !== undefined) {
    if (metadata.displayPrefixLength === 2 && content.startsWith('\n\n')) content = content.slice(2);
    else unavailable = 'conflict';
  }
  return { identity, channel, content, unavailable, metadata, mode };
}

/** Extract before legacy keyMessages' 140-char clipping; never persist an unbounded compact payload. */
export function compactAssistantOutput(event: Record<string, unknown>): AssistantOutputFragment | undefined {
  if (!['text', 'assistant'].includes(String(event.type)) || (event.role !== undefined && event.role !== 'assistant'))
    return undefined;
  const { identity, channel, content, unavailable, metadata, mode } = outputObservation(event);
  const byteLength = Buffer.byteLength(content, 'utf8');
  return {
    ...(identity ? { identity } : {}),
    ...(channel ? { channel } : {}),
    ...(unavailable ? { unavailable } : {}),
    complete: metadata?.complete === true,
    ...(mode ? { mode } : {}),
    byteLength,
    ...(content.charCodeAt(0) >= 0xdc00 && content.charCodeAt(0) <= 0xdfff ? { startsWithLowSurrogate: true } : {}),
    ...(content.charCodeAt(content.length - 1) >= 0xd800 && content.charCodeAt(content.length - 1) <= 0xdbff
      ? { endsWithHighSurrogate: true }
      : {}),
    ...(!unavailable && byteLength <= MAX_FIRST_ASSISTANT_OUTPUT_BYTES ? { content } : {}),
  };
}

function applyOutputFragment(first: AssistantOutputFragment, fragment: AssistantOutputFragment): void {
  first.complete = fragment.complete;
  // Separate JSON strings encode unmatched surrogates as U+FFFD (3 bytes each).
  // Joining a split pair encodes one codepoint (4 bytes), including when content was oversized.
  const joinedSurrogatePair = first.endsWithHighSurrogate && fragment.startsWithLowSurrogate;
  first.byteLength =
    fragment.mode === 'replace'
      ? fragment.byteLength
      : first.byteLength + fragment.byteLength - (joinedSurrogatePair ? 2 : 0);
  if (fragment.mode === 'replace' || fragment.byteLength > 0)
    first.endsWithHighSurrogate = fragment.endsWithHighSurrogate;
  first.content =
    fragment.mode === 'replace'
      ? fragment.content
      : first.content !== undefined && fragment.content !== undefined
        ? first.content + fragment.content
        : undefined;
  if (first.byteLength > MAX_FIRST_ASSISTANT_OUTPUT_BYTES) delete first.content;
}

const BOUNDARIES = new Set([
  'tool_use',
  'tool_result',
  'error',
  'done',
  'user',
  'system',
  'session_init',
  'system_info',
  'turn.started',
  'turn.completed',
]);

/** Bounded state for exactly the earliest candidate, never a search for a later available final. */
export class FirstAssistantOutputAccumulator {
  private candidate?: AssistantOutputFragment;
  private source?: FirstAssistantOutputEvidence['source'];
  private closed = false;

  add(envelope: TranscriptEvent, fragment = compactAssistantOutput(envelope.event)): void {
    if (!envelope.invocationId) return;
    if (!fragment) {
      if (this.candidate && (BOUNDARIES.has(String(envelope.event.type)) || envelope.event.role !== undefined))
        this.closed = true;
      return;
    }
    if (!this.candidate) {
      this.candidate = { ...fragment };
      this.source = {
        sessionId: envelope.sessionId,
        invocationId: envelope.invocationId,
        firstEventNo: envelope.eventNo,
        lastEventNo: envelope.eventNo,
        eventCount: 1,
      };
      return;
    }
    const first = this.candidate;
    const source = this.source;
    if (!source) return;
    if (!first.identity || !fragment.identity || !sameOutputMessageIdentity(first.identity, fragment.identity)) {
      this.closed = true;
      return;
    }
    if (first.unavailable) return;
    source.lastEventNo = envelope.eventNo;
    source.eventCount += 1;
    if (this.closed || first.complete || fragment.channel !== first.channel || fragment.unavailable) {
      first.unavailable = 'conflict';
      delete first.content;
      return;
    }
    applyOutputFragment(first, fragment);
  }

  value(): FirstAssistantOutputEvidence | undefined {
    const first = this.candidate;
    if (!first || !this.source) return undefined;
    const common = {
      role: 'assistant' as const,
      complete: first.complete,
      source: { ...this.source },
      byteLength: first.byteLength,
    };
    if (!first.unavailable && first.complete && first.identity && first.channel && first.content !== undefined) {
      return {
        ...common,
        status: 'available',
        identity: first.identity,
        channel: first.channel,
        content: first.content,
      };
    }
    return {
      ...common,
      status: first.unavailable ?? (first.byteLength > MAX_FIRST_ASSISTANT_OUTPUT_BYTES ? 'oversized' : 'incomplete'),
      ...(first.identity ? { identity: first.identity } : {}),
      ...(first.channel ? { channel: first.channel } : {}),
    };
  }
}
