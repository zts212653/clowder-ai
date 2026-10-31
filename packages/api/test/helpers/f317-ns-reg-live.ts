// F317 north-star regression harness (Sonnet, regression support). No media, no visible cat.
// Real LiveCompanionCall + real MessageStore; the only fakes are the in-process native
// transport and the publish sink. Mirrors the technique used by f317-live-text-retry.test.ts
// and the #4922 owner-local-note simulation, without editing either.
import { resolve } from 'node:path';
import { type CompanionIdentitySnapshotV1, createCatId, createCompanionIdentitySnapshot } from '@cat-cafe/shared';
import type { CodexLiveNativeClient } from '../../src/domains/cats/services/agents/providers/CodexLiveRunPort.js';
import { MessageStore, type StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveCompanionCall } from '../../src/domains/concierge/live/LiveCompanionCall.js';

export const OWNER = 'owner';
export const THREAD = 'home';
export const NATIVE_THREAD = 'native-ns-reg';

export const identity: CompanionIdentitySnapshotV1 = createCompanionIdentitySnapshot({
  duty: { catId: 'fable-5', displayName: '宪宪' },
  carrier: { catId: 'codex-astra', displayName: '砚砚' },
  skin: 'black-cat',
  liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
});

export interface HarnessOptions {
  readonly callId?: string;
  readonly store?: MessageStore;
  readonly realtimeSessionId?: string;
  readonly nativeThreadId?: string;
  readonly threadId?: string;
  readonly withIdentity?: boolean;
  /** Default: accept and return a turn id. Throw to simulate rejection or an ambiguous transport failure. */
  readonly submitText?: (text: string, source: string) => Promise<string>;
}

export interface SubmittedText {
  readonly text: string;
  readonly source: string;
}

export const voiceEnvelope = (
  realtimeSessionId: string,
  role: 'user' | 'assistant' | 'system',
  itemId: string,
  text: string,
  nativeThreadId = NATIVE_THREAD,
) => ({
  method: 'thread/realtime/item/completed',
  params: {
    threadId: nativeThreadId,
    item: { id: itemId, realtimeSessionId, type: 'transcriptSegment', role, text },
  },
});

export const resultEnvelope = (turnId: string, itemId: string, text: string, nativeThreadId = NATIVE_THREAD) => ({
  method: 'item/completed',
  params: { threadId: nativeThreadId, turnId, item: { type: 'agentMessage', id: itemId, phase: 'final_answer', text } },
});

/** A prepared, talking Live call with an observable native transport. */
export async function liveHarness(options: HarnessOptions = {}) {
  const store = options.store ?? new MessageStore();
  const published: StoredMessage[] = [];
  const submitted: SubmittedText[] = [];
  const nativeThreadId = options.nativeThreadId ?? NATIVE_THREAD;
  const realtimeSessionId = options.realtimeSessionId ?? 'rtc-1';
  const callId = options.callId ?? 'call-1';
  const threadId = options.threadId ?? THREAD;
  const call = await LiveCompanionCall.create({
    binding: { userId: OWNER, threadId, catId: createCatId('codex-astra'), callId },
    messageStore: store,
    mcpDistDir: resolve('../mcp-server/dist'),
    allowedDirectories: [resolve('../../docs')],
    verifyNativeBinding: async () => true,
    ...(options.withIdentity === false ? {} : { identitySnapshot: identity }),
    publish: (message) => {
      published.push(message);
    },
  });
  const client: CodexLiveNativeClient = {
    submitText: async (text, source) => {
      submitted.push({ text, source });
      return (options.submitText ?? (async () => 'turn-accepted'))(text, source);
    },
    request: async (method) => {
      if (method === 'thread/realtime/start') {
        await call.observe({
          method: 'thread/realtime/started',
          params: { threadId: nativeThreadId, realtimeSessionId },
        });
        await call.observe({ method: 'thread/realtime/sdp', params: { threadId: nativeThreadId, sdp: 'answer' } });
      }
      if (method === 'thread/realtime/stop')
        await call.observe({ method: 'thread/realtime/closed', params: { threadId: nativeThreadId } });
      return {};
    },
  };
  await call.ready(nativeThreadId, client);
  await call.start('offer');
  return {
    call,
    store,
    published,
    submitted,
    callId,
    threadId,
    nativeThreadId,
    realtimeSessionId,
    rows: () => store.getByThread(threadId, 100, OWNER),
    voice: (role: 'user' | 'assistant' | 'system', itemId: string, text: string) =>
      call.observe(voiceEnvelope(realtimeSessionId, role, itemId, text, nativeThreadId)),
    /** Anything the provider would replay from another realtime session. */
    foreignVoice: (sessionId: string, role: 'user' | 'assistant', itemId: string, text: string) =>
      call.observe(voiceEnvelope(sessionId, role, itemId, text, nativeThreadId)),
  };
}

/** Projection of what a subtitle/history consumer could legitimately be told about a saved row. */
export const liveOf = (message: StoredMessage) => message.extra?.liveCompanion;
