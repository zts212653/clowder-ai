import type { StoredMessage } from '../../../../cats/services/stores/ports/MessageStore.js';
import type { HomeActionRequest } from '../../../action/HomeActionController.js';
import type { LiveContextScope } from '../live-controlled-context.js';
import { directOwner, sameScope, sha256 } from '../page-action/live-page-action-authority-contract.js';
import type { OwnerCurrentnessStore } from '../voice/live-owner-currentness.js';
import { isLatestOwnerMessage } from '../voice/live-owner-currentness.js';
import type { LiveOwnerVoiceContext } from '../voice/live-owner-voice.js';

export async function readLiveHomeRequest(input: {
  messages: OwnerCurrentnessStore;
  currentScope(): LiveContextScope | null;
  isCurrentThread(userId: string, threadId: string): Promise<boolean>;
  authorize(): Promise<boolean>;
  voice: Pick<LiveOwnerVoiceContext, 'currentSignal' | 'currentEpoch' | 'inspectUtterance'>;
  available(): boolean;
  exposed(message: StoredMessage): boolean;
}): Promise<(HomeActionRequest & { scope: LiveContextScope }) | null> {
  const { messages, voice } = input;
  const scope = input.currentScope();
  const signal = voice.currentSignal();
  const epoch = voice.currentEpoch();
  if (!input.available() || !scope || signal.aborted || !(await input.authorize())) return null;
  if (!(await input.isCurrentThread(scope.userId, scope.threadId))) return null;
  const recent = await messages.getByThread(scope.threadId, 256, scope.userId, {
    includeQueuedUserMessages: true,
    includeRecalledUserMessages: true,
  });
  const source = recent.filter((message) => message.userId === scope.userId && message.catId === null).at(-1);
  if (
    !source ||
    Date.now() - source.timestamp >= 120_000 ||
    !input.exposed(source) ||
    !directOwner(source, scope, input.exposed(source))
  )
    return null;
  const payload =
    source.extra?.liveCompanion?.modality === 'voice'
      ? await voice.inspectUtterance(scope, source)
      : { text: source.content, messages: [source] };
  if (!payload || !payload.text.trim() || payload.text.length > 8_000) return null;
  if (
    !(await isLatestOwnerMessage(
      messages,
      scope,
      source,
      payload.messages.map((m) => m.id),
    ))
  )
    return null;
  const current = input.currentScope();
  if (!input.available() || signal.aborted || epoch !== voice.currentEpoch() || !current || !sameScope(scope, current))
    return null;
  return {
    scope,
    messageId: source.id,
    userId: scope.userId,
    callId: scope.callId,
    text: payload.text,
    revision: sha256(JSON.stringify([scope, epoch, payload.messages.map((m) => [m.id, m.content])])),
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, source.timestamp + 120_000 - Date.now()))]),
  };
}
