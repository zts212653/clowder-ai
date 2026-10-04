import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore, type StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { type LivePageActionPort, pageActionGrantSha256 } from '../../src/domains/concierge/action/LivePageAction.js';
import { LivePageActionApprovalLedger } from '../../src/domains/concierge/live/host/live-page-action-approval-ledger.js';
import {
  LivePageActionAuthority,
  type TrustedPageActionApproval,
} from '../../src/domains/concierge/live/host/live-page-action-authority.js';
import { LiveCompanionCall } from '../../src/domains/concierge/live/LiveCompanionCall.js';

export const scope = {
  userId: 'owner',
  threadId: 'home',
  catId: createCatId('codex6-sol'),
  invocationId: 'live-invocation',
  callId: 'live-call',
  generation: 1,
};

export function appendUser(store: MessageStore, content: string, idempotencyKey: string, timestamp = Date.now()) {
  return store.appendIdempotent({
    userId: 'owner',
    threadId: 'home',
    catId: null,
    content,
    mentions: [],
    timestamp,
    idempotencyKey,
  }).message;
}

export function fixture(sourceTimestamp = Date.now()) {
  const store = new MessageStore();
  const source = appendUser(store, 'Fill the approved note', 'owner-request-1', sourceTimestamp);
  let currentScope = scope;
  let approvalCurrent = true;
  let effects = 0;
  let closed = false;
  let approvalChecks = 0;
  let onApprovalCheck: () => Promise<void> = async () => {};
  let onInspect: () => Promise<void> = async () => {};
  const fingerprint = `sha256:${createHash('sha256').update('one-dom-node').digest('hex')}`;
  const port: LivePageActionPort & { close(): Promise<void> } = {
    async inspect() {
      await onInspect();
      return {
        origin: 'http://127.0.0.1:5227',
        url: 'http://127.0.0.1:5227/',
        readback: effects ? 'filled' : 'empty',
        candidates: [{ id: 'note', operation: 'fill', label: 'Note', fingerprint }],
      };
    },
    async perform(_choice, _fingerprint, _url, _revision, fence) {
      const state = await fence();
      if (state !== 'current') return state;
      effects++;
      return 'applied';
    },
    async close() {
      closed = true;
    },
  };
  const approval: TrustedPageActionApproval = {
    approvalId: 'owner-confirmation-1',
    permissionScope: 'fixture-note-only',
    expiresAtMs: Date.now() + 60_000,
    origin: 'http://127.0.0.1:5227',
    url: 'http://127.0.0.1:5227/',
    targetId: 'note',
    operation: 'fill',
    value: 'filled',
    expectedReadback: 'filled',
  };
  const authority = new LivePageActionAuthority({
    currentScope: () => currentScope,
    messages: store,
    isCurrentThread: async (userId, threadId) => userId === 'owner' && threadId === 'home',
    verifyCompanion: async () => true,
    verifyApproval: async ({ approvalId, requestSourceRef, actionSha256, signal }) => {
      approvalChecks++;
      assert.equal(approvalId, approval.approvalId);
      assert.equal(requestSourceRef, `home#${source.id}`);
      assert.match(actionSha256, /^[0-9a-f]{64}$/);
      assert.equal(signal.aborted, false);
      await onApprovalCheck();
      return approvalCurrent;
    },
    run: (operation) => operation(),
  });
  const selector = {
    async select() {
      return { kind: 'act' as const, targetId: 'note', operation: 'fill' as const, value: 'filled' };
    },
  };
  return {
    authority,
    store,
    source,
    port,
    approval,
    selector,
    effects: () => effects,
    closed: () => closed,
    approvalChecks: () => approvalChecks,
    revokeApproval: () => {
      approvalCurrent = false;
    },
    changeScope: () => {
      currentScope = { ...scope, generation: 2 };
    },
    onApprovalCheck: (callback: () => Promise<void>) => {
      onApprovalCheck = callback;
    },
    onInspect: (callback: () => Promise<void>) => {
      onInspect = callback;
    },
  };
}

export async function issueFixtureApproval(
  ledger: LivePageActionApprovalLedger,
  f: ReturnType<typeof fixture>,
  source: StoredMessage = f.source,
  approval: TrustedPageActionApproval = f.approval,
): Promise<
  import('../../src/domains/concierge/live/host/live-page-action-approval-ledger.js').PageActionApprovalRecord
> {
  const snapshot = await f.port.inspect();
  const target = snapshot.candidates.find((candidate) => candidate.id === approval.targetId);
  assert.ok(target);
  const requestRevision = createHash('sha256')
    .update(JSON.stringify([source.id, source.content]))
    .digest('hex');
  const record = {
    approvalId: approval.approvalId,
    scope,
    requestSourceRef: `${scope.threadId}#${source.id}`,
    requestRevision,
    actionSha256: pageActionGrantSha256({
      origin: approval.origin,
      url: approval.url,
      requestRevision,
      actions: [
        {
          targetId: target.id,
          operation: target.operation,
          ...(approval.value === undefined ? {} : { value: approval.value }),
          fingerprint: target.fingerprint,
          expectedReadback: approval.expectedReadback,
        },
      ],
    }),
    permissionScope: approval.permissionScope,
    expiresAtMs: approval.expiresAtMs,
  };
  ledger.issue(record);
  return record;
}

export async function startedActionCall(f: ReturnType<typeof fixture>) {
  const approvalLedger = new LivePageActionApprovalLedger();
  await issueFixtureApproval(approvalLedger, f);
  const call = await LiveCompanionCall.create({
    binding: { userId: scope.userId, threadId: scope.threadId, catId: scope.catId, callId: scope.callId },
    messageStore: f.store,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    pageAction: {
      messages: f.store,
      isCurrentThread: async (userId, threadId) => userId === scope.userId && threadId === scope.threadId,
      approvalLedger,
    },
    verifyNativeBinding: async () => true,
    publish() {},
  });
  await call.configure({
    CAT_CAFE_API_URL: 'http://localhost:3012',
    CAT_CAFE_USER_ID: scope.userId,
    CAT_CAFE_THREAD_ID: scope.threadId,
    CAT_CAFE_CAT_ID: scope.catId,
    CAT_CAFE_INVOCATION_ID: scope.invocationId,
    CAT_CAFE_CALLBACK_TOKEN: 'token',
  });
  await call.ready('native', {
    submitText: async () => 'turn',
    request: async (method) => {
      if (method === 'thread/realtime/start') {
        await call.observe({
          method: 'thread/realtime/started',
          params: { threadId: 'native', realtimeSessionId: 'rtc' },
        });
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: 'native', sdp: 'answer' } });
      }
      return {};
    },
  });
  await call.start('offer');
  return { call, approvalLedger };
}
