import {
  type OutputMessageIdentity,
  readOutputMessageChannel,
  readOutputMessageIdentity,
  sameOutputMessageIdentity,
} from '@cat-cafe/shared';
import type { InvocationTimelineRow, RawTranscriptEvent } from './invocation-trajectory-model';

type MessageRow = Extract<InvocationTimelineRow, { kind: 'message' }>;
export interface NativeMessageCursor {
  row: MessageRow;
  identity: OutputMessageIdentity;
  envelope: RawTranscriptEvent;
  complete: boolean;
}
interface NativeMessageState {
  rows: InvocationTimelineRow[];
  nativeMessageCursor?: NativeMessageCursor;
}
const MESSAGE_ROLES = new Set(['assistant', 'user', 'system', 'context']);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

function textContent(event: Record<string, unknown>): string | undefined {
  if (typeof event.content === 'string') return event.content;
  if (!Array.isArray(event.content)) return undefined;
  const parts = event.content.flatMap((part) => {
    const item = record(part);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  });
  return parts.length ? parts.join('\n') : undefined;
}

function nativeMode(native: Record<string, unknown> | undefined, event: Record<string, unknown>) {
  // undefined has the same meaning before and after canonical JSON omission.
  const selected =
    native && Object.hasOwn(native, 'textMode') && native.textMode !== undefined
      ? native.textMode
      : Object.hasOwn(event, 'textMode') && event.textMode !== undefined
        ? event.textMode
        : 'append';
  return selected === 'append' || selected === 'replace' ? selected : undefined;
}

function sameInvocation(a: RawTranscriptEvent, b: RawTranscriptEvent): boolean {
  return (
    Boolean(a.invocationId) &&
    a.invocationId === b.invocationId &&
    a.sessionId === b.sessionId &&
    a.threadId === b.threadId &&
    a.catId === b.catId
  );
}

function canJoinNativeMessage(state: NativeMessageState, next: NativeMessageCursor): boolean {
  const previous = state.nativeMessageCursor;
  return Boolean(
    previous &&
      !previous.complete &&
      previous.row === state.rows.at(-1) &&
      previous.row.channel === next.row.channel &&
      sameInvocation(previous.envelope, next.envelope) &&
      sameOutputMessageIdentity(previous.identity, next.identity),
  );
}

function observeNativeMessage(envelope: RawTranscriptEvent, role: MessageRow['role'], text: string) {
  const native = record(envelope.event.outputMessage);
  const identity = readOutputMessageIdentity(native);
  const channel = readOutputMessageChannel(native?.channel);
  const mode = nativeMode(native, envelope.event);
  const prefix = native?.displayPrefixLength;
  const validPrefix = prefix === undefined || (prefix === 2 && text.startsWith('\n\n'));
  const content = prefix === 2 && validPrefix ? text.slice(2) : text;
  const row: MessageRow = {
    id: `message-${envelope.eventNo}`,
    kind: 'message',
    timestamp: envelope.t,
    role,
    content,
    ...(role === 'assistant'
      ? {
          fragmentCount: 1,
          appendCount: Number(mode === 'append'),
          replaceCount: Number(mode === 'replace'),
          ...(channel ? { channel } : {}),
        }
      : {}),
  };
  const cursor =
    role === 'assistant' && identity && channel && mode && validPrefix
      ? { row, identity, envelope, complete: native?.complete === true }
      : undefined;
  return { row, cursor, mode };
}

function nativeRole(event: Record<string, unknown>, type: string): MessageRow['role'] | undefined {
  const implicit = type === 'text' ? 'assistant' : type;
  // Match canonical JSON omission, while null and all explicit invalid roles
  // remain unavailable. A typed event cannot contradict its explicit role.
  if (event.role === undefined) return implicit as MessageRow['role'];
  if (typeof event.role !== 'string' || !MESSAGE_ROLES.has(event.role)) return undefined;
  if (type !== 'text' && event.role !== implicit) return undefined;
  return event.role as MessageRow['role'];
}

export function appendNativeMessage(state: NativeMessageState, envelope: RawTranscriptEvent, type: string): void {
  const role = nativeRole(envelope.event, type);
  if (!role) {
    state.nativeMessageCursor = undefined;
    return;
  }
  const text = textContent(envelope.event);
  if (text === undefined) {
    state.nativeMessageCursor = undefined;
    return;
  }
  const { row, cursor, mode } = observeNativeMessage(envelope, role, text);
  const previous = state.nativeMessageCursor;
  if (cursor && previous && canJoinNativeMessage(state, cursor)) {
    previous.row.content = mode === 'replace' ? row.content : `${previous.row.content}${row.content}`;
    previous.row.fragmentCount = (previous.row.fragmentCount ?? 1) + 1;
    previous.row.appendCount = (previous.row.appendCount ?? 0) + Number(mode === 'append');
    previous.row.replaceCount = (previous.row.replaceCount ?? 0) + Number(mode === 'replace');
    previous.complete = cursor.complete;
  } else {
    state.rows.push(row);
    state.nativeMessageCursor = cursor;
  }
}
