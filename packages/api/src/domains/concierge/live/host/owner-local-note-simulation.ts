import { randomUUID } from 'node:crypto';
import { createCatId } from '@cat-cafe/shared';
import type { CodexLiveNativeClient } from '../../../cats/services/agents/providers/CodexLiveRunPort.js';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ConciergeThreadService } from '../../ConciergeThreadService.js';
import type { LiveCompanionCall } from '../LiveCompanionCall.js';
import type { LiveCompanionSessions } from '../LiveCompanionSessions.js';
import { assertOwnerLocalNoteLabIsolation, type OwnerLocalNoteLabOptions } from './owner-local-note-lab.js';
import type { OwnerPageActionService } from './owner-page-action-service.js';

const NATIVE_THREAD_ID = 'f317_local_note_simulation';
const SIMULATION_MS = 15 * 60_000;
const RENEW_MS = 30_000;
const REQUEST_TEXT =
  '【模拟请求｜F317 本地便签试验】仅在 Host 自建的临时便签页填入 F317 local trial，核对回读后恢复空值。这不是co-creator的真实指令。';

interface Input {
  readonly isolation: OwnerLocalNoteLabOptions;
  readonly ownerUserId: string;
  readonly sessions: LiveCompanionSessions;
  readonly service: OwnerPageActionService;
  readonly messages: Pick<IMessageStore, 'appendIdempotent' | 'getById' | 'getByThread' | 'getByThreadAfter'>;
  readonly threadService: Pick<ConciergeThreadService, 'getOrCreate' | 'isCurrent'>;
  readonly mcpDistDir: string;
  readonly allowedDirectories: readonly string[];
  readonly apiUrl: string;
}

export interface OwnerLocalNoteSimulation {
  readonly callId: string;
  readonly requestMessageId: string;
  readonly threadId: string;
  stop(): Promise<void>;
}

function simulatedNative(call: LiveCompanionCall): CodexLiveNativeClient {
  return {
    async submitText() {
      throw new Error('Local note simulation has no text transport');
    },
    async request(method) {
      if (method === 'thread/realtime/stop') return {};
      if (method !== 'thread/realtime/start') throw new Error('Local note simulation has no native transport');
      await call.observe({
        method: 'thread/realtime/started',
        params: { threadId: NATIVE_THREAD_ID, realtimeSessionId: 'f317_local_note_no_media' },
      });
      await call.observe({
        method: 'thread/realtime/sdp',
        params: { threadId: NATIVE_THREAD_ID, sdp: 'f317_local_note_no_media' },
      });
      return {};
    },
  };
}

/** A labeled, memory-only source and in-process native stub for the owner consent UI. */
export async function startOwnerLocalNoteSimulation(input: Input): Promise<OwnerLocalNoteSimulation> {
  assertOwnerLocalNoteLabIsolation(input.isolation);
  if (input.apiUrl !== `http://127.0.0.1:${input.isolation.apiPort}` || !input.service.enabled)
    throw new Error('Local note simulation admission unavailable');
  const threadId = await input.threadService.getOrCreate(input.ownerUserId);
  const catId = createCatId('codex6-sol');
  const callId = randomUUID();
  const invocationId = randomUUID();
  const callbackToken = randomUUID();
  const ledger = input.service.newLedger();
  let call: LiveCompanionCall | undefined;
  try {
    call = await input.sessions.prepare({
      binding: { userId: input.ownerUserId, threadId, catId, callId },
      messageStore: input.messages,
      mcpDistDir: input.mcpDistDir,
      allowedDirectories: input.allowedDirectories,
      householdToolsEnabled: false,
      verifyCompanion: async () => true,
      verifyNativeBinding: async (nativeId) => nativeId === NATIVE_THREAD_ID,
      pageAction: {
        messages: input.messages,
        isCurrentThread: (userId, currentThreadId) => input.threadService.isCurrent(userId, currentThreadId),
        approvalLedger: ledger,
      },
      publish() {},
    });
    input.service.bindCall(call, ledger);
    input.sessions.claim(callId, input.ownerUserId, threadId, [catId]);
    await call.configure({
      CAT_CAFE_API_URL: input.apiUrl,
      CAT_CAFE_USER_ID: input.ownerUserId,
      CAT_CAFE_THREAD_ID: threadId,
      CAT_CAFE_CAT_ID: catId,
      CAT_CAFE_INVOCATION_ID: invocationId,
      CAT_CAFE_CALLBACK_TOKEN: callbackToken,
    });
    await call.ready(NATIVE_THREAD_ID, simulatedNative(call));
    await call.start('f317_local_note_no_media');
    const appended = await input.messages.appendIdempotent({
      userId: input.ownerUserId,
      threadId,
      catId: null,
      content: REQUEST_TEXT,
      mentions: [],
      timestamp: Date.now(),
      idempotencyKey: `f317-local-note-simulation-${callId}`,
    });
    const currentCall = call;
    const renewal = setInterval(() => currentCall.touchSurface(), RENEW_MS);
    renewal.unref();
    let stopping: Promise<void> | undefined;
    const stop = () => {
      clearInterval(renewal);
      clearTimeout(expiry);
      stopping ??= currentCall.stop();
      return stopping;
    };
    const expiry = setTimeout(() => void stop().catch(() => {}), SIMULATION_MS);
    expiry.unref();
    void currentCall.finished
      .finally(() => {
        clearInterval(renewal);
        clearTimeout(expiry);
      })
      .catch(() => {});
    return { callId, requestMessageId: appended.message.id, threadId, stop };
  } catch (error) {
    ledger.close();
    await call?.stop();
    throw error;
  }
}
