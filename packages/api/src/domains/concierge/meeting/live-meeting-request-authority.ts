import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { LiveContextScope } from '../live/host/live-controlled-context.js';
import { directOwner, sameScope, sha256 } from '../live/host/page-action/live-page-action-authority-contract.js';
import { isLatestOwnerMessage } from '../live/host/voice/live-owner-currentness.js';
import type { LiveCompanionCall } from '../live/LiveCompanionCall.js';
import type { F317LiveCallObservation } from './f317-meeting-admission.js';
import type { LiveMeetingPrincipal, LiveMeetingRequest } from './live-meeting-control-contract.js';

interface VoiceInspection {
  currentSignal(): AbortSignal;
  currentEpoch(): number;
  availableForAction(): boolean;
  inspectUtterance(
    scope: LiveContextScope,
    message: StoredMessage,
  ): Promise<{ text: string; messages: readonly StoredMessage[] } | null>;
}

type MeetingCallView = Pick<
  LiveCompanionCall,
  'contextScope' | 'householdToolsEnabled' | 'acceptsInput' | 'hasCurrentCompanion' | 'exposureReason'
> & {
  boundaryContexts: { ownerVoice: Partial<VoiceInspection> };
};
interface Options {
  ownerUserId: string;
  sessions: {
    get(id: string, userId: string): MeetingCallView | undefined;
    observeCall(userId: string): Promise<F317LiveCallObservation | null>;
  };
  messages: Pick<IMessageStore, 'getById' | 'getByThread' | 'getByThreadAfter'>;
  threads: Pick<IThreadStore, 'get'>;
  isCurrentThread(userId: string, threadId: string): Promise<boolean>;
}

async function readCall(options: Options, principal: LiveMeetingPrincipal) {
  if (principal.userId !== options.ownerUserId) throw new Error('meeting_owner_required');
  const observed = await options.sessions.observeCall(principal.userId);
  const call = observed && options.sessions.get(observed.callId, principal.userId);
  const scope = call?.contextScope(principal);
  if (!observed || !call || !scope || !call.acceptsInput()) throw new Error('meeting_current_live_required');
  const expected = {
    ...scope,
    userId: principal.userId,
    invocationId: principal.invocationId,
    threadId: principal.threadId,
    catId: principal.catId,
    callId: observed.callId,
    generation: observed.generation,
  };
  if (!sameScope(scope, expected) || observed.threadId !== scope.threadId || observed.catId !== scope.catId)
    throw new Error('meeting_current_live_required');
  if (
    (await options.threads.get(scope.threadId))?.createdBy !== principal.userId ||
    !(await options.isCurrentThread(scope.userId, scope.threadId))
  )
    throw new Error('meeting_current_live_required');
  return { call, scope };
}

function voiceReader(call: MeetingCallView) {
  const voice = call.boundaryContexts.ownerVoice;
  if (!voice.currentSignal || !voice.currentEpoch || !voice.availableForAction || !voice.inspectUtterance)
    throw new Error('meeting_owner_utterance_reader_unavailable');
  return voice as VoiceInspection;
}

async function readRequest(
  options: Options,
  call: MeetingCallView,
  scope: LiveContextScope,
  voice: VoiceInspection,
  requestId?: string,
) {
  const message = requestId
    ? await options.messages.getById(requestId)
    : (
        await options.messages.getByThread(scope.threadId, 256, scope.userId, {
          includeQueuedUserMessages: true,
          includeRecalledUserMessages: true,
        })
      )
        .filter((m) => m.userId === scope.userId && m.catId === null)
        .at(-1);
  const exposed = message && call.exposureReason(message) === 'same_live_call_exposure';
  if (!message || !exposed || !directOwner(message, scope, exposed) || Date.now() - message.timestamp >= 120_000)
    throw new Error('meeting_request_unavailable');
  const payload =
    message.extra?.liveCompanion?.modality === 'voice'
      ? await voice.inspectUtterance(scope, message)
      : { text: message.content, messages: [message] };
  if (!payload || !payload.text.trim() || payload.text.length > 8_000) throw new Error('meeting_request_unavailable');
  if (
    !(await isLatestOwnerMessage(
      options.messages,
      scope,
      message,
      payload.messages.map((m) => m.id),
    ))
  )
    throw new Error('meeting_request_unavailable');
  return { message, payload };
}

/** Human evidence is Host-owned; missing whole-utterance seams never fall back to one voice segment. */
export function createLiveMeetingRequestAuthority(options: Options) {
  return async (
    principal: LiveMeetingPrincipal,
    requestId?: string,
    requireRequest = false,
  ): Promise<LiveMeetingRequest> => {
    const { call, scope } = await readCall(options, principal);
    if (!requestId && !requireRequest) return { scope };
    const voice = voiceReader(call),
      signal = voice.currentSignal(),
      epoch = voice.currentEpoch();
    if (signal.aborted || !voice.availableForAction()) throw new Error('meeting_request_unavailable');
    const { message, payload } = await readRequest(options, call, scope, voice, requestId);
    const next = await readCall(options, principal);
    if (
      !sameScope(scope, next.scope) ||
      !(await call.hasCurrentCompanion()) ||
      signal.aborted ||
      epoch !== voice.currentEpoch() ||
      !voice.availableForAction()
    )
      throw new Error('meeting_current_live_required');
    return {
      scope,
      request: {
        id: message.id,
        text: payload.text,
        revision: sha256(JSON.stringify([scope, epoch, payload.messages.map((m) => [m.id, m.content])])),
      },
    };
  };
}
