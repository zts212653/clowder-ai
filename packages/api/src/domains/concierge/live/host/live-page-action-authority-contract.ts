import { createHash } from 'node:crypto';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { LivePageActionGrant, LivePageActionPort } from '../../action/LivePageAction.js';
import type { PageOperation } from '../../action/PageActionLoop.js';
import type { LiveContextScope } from './live-controlled-context.js';

const MAX_GRANT_MS = 120_000;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sameScope(a: LiveContextScope, b: LiveContextScope): boolean {
  return (
    a.userId === b.userId &&
    a.threadId === b.threadId &&
    a.catId === b.catId &&
    a.invocationId === b.invocationId &&
    a.callId === b.callId &&
    a.generation === b.generation
  );
}

export function directOwner(message: StoredMessage, scope: LiveContextScope): boolean {
  const live = message.extra?.liveCompanion;
  const directTyped =
    live?.modality === 'typed' &&
    live.role === 'user' &&
    live.callId === scope.callId &&
    typeof live.clientMessageId === 'string' &&
    live.clientMessageId.trim().length > 0 &&
    live.clientMessageId.length <= 256;
  return (
    message.userId === scope.userId &&
    message.threadId === scope.threadId &&
    message.catId === null &&
    !message.source &&
    !message.sourceParseFailure &&
    !message.recall &&
    !message.deletedAt &&
    !message._tombstone &&
    message.deliveryStatus !== 'queued' &&
    message.deliveryStatus !== 'canceled' &&
    message.visibility !== 'whisper' &&
    !message.extra?.crossPost &&
    !message.extra?.realtimeCompanion &&
    (!live || directTyped)
  );
}

export interface TrustedPageActionApproval {
  readonly approvalId: string;
  readonly permissionScope: string;
  readonly expiresAtMs: number;
  readonly origin: string;
  readonly url: string;
  readonly targetId: string;
  readonly operation: PageOperation;
  readonly value?: string;
  readonly expectedReadback: string;
}

export function validApproval(input: TrustedPageActionApproval, now: number): boolean {
  let origin: string;
  try {
    const url = new URL(input.url);
    origin = url.origin;
    if (!['http:', 'https:'].includes(url.protocol)) return false;
  } catch {
    return false;
  }
  return (
    origin === input.origin &&
    input.approvalId.length > 0 &&
    input.approvalId.length <= 160 &&
    input.permissionScope.length > 0 &&
    input.permissionScope.length <= 160 &&
    input.targetId.length > 0 &&
    input.targetId.length <= 160 &&
    (input.operation === 'click' || input.operation === 'fill') &&
    (input.operation !== 'fill' || typeof input.value === 'string') &&
    (input.value === undefined || input.value.length <= 2_000) &&
    input.expectedReadback.length > 0 &&
    input.expectedReadback.length <= 4_000 &&
    Number.isSafeInteger(input.expiresAtMs) &&
    input.expiresAtMs > now &&
    input.expiresAtMs <= now + MAX_GRANT_MS
  );
}

export type ClosableLivePageActionPort = LivePageActionPort & { close(): Promise<void> };

export async function closePort(port: ClosableLivePageActionPort): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => port.close()),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Page actor cleanup unconfirmed')), 150);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface LivePageActionAuthorityDeps {
  currentScope(): LiveContextScope | null;
  messages: Pick<IMessageStore, 'getById' | 'getByThread' | 'getByThreadAfter'>;
  isCurrentThread(userId: string, threadId: string): Promise<boolean>;
  verifyCompanion(): Promise<boolean>;
  /** Host-generated call admission is a carrier instruction, not a direct human action request. */
  isHostAdmissionSource?(messageId: string): boolean;
  /** Reads an independent direct-owner approval source, including revocation. */
  verifyApproval(input: {
    approvalId: string;
    scope: LiveContextScope;
    requestSourceRef: string;
    requestRevision: string;
    actionSha256: string;
    permissionScope: string;
    expiresAtMs: number;
    signal: AbortSignal;
  }): Promise<boolean>;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface ActiveAction {
  readonly authorityId: string;
  readonly scope: LiveContextScope;
  readonly requestMessageId: string;
  readonly request: { sourceRef: string; revision: string; text: string };
  readonly approvalId: string;
  readonly grant: LivePageActionGrant;
  readonly port: ClosableLivePageActionPort;
  readonly controller: AbortController;
  executing: boolean;
}
