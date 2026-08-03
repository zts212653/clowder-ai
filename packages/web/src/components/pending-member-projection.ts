import type { AppServerLifecycleStage, CatInvocationInfo, ChatMessage } from '@/stores/chat-types';

type ActiveInvocationSlots = Record<string, { catId: string; mode: string; startedAt?: number }>;

export interface PendingMemberInvocation {
  invocationId: string;
  catId: string;
}

/**
 * Lifecycle stages at which the backend has confirmed the turn is executing.
 * Before `turn_accepted` the cat is still starting up — the pre-start
 * placeholder (avatar + frame + tips) must stay.
 */
const EXECUTING_LIFECYCLE_STAGES: ReadonlySet<AppServerLifecycleStage> = new Set([
  'turn_accepted',
  'active',
  'completed',
  'interrupted',
  'failed',
  'closing',
  'closed',
]);

function normalizeActiveInvocationId(invocationId: string, catId: string): string {
  const fanoutSuffix = `-${catId}`;
  return invocationId.endsWith(fanoutSuffix) ? invocationId.slice(0, -fanoutSuffix.length) : invocationId;
}

/**
 * A pending member bubble lives and dies with its own invocation: it renders
 * until THAT invocation's lifecycle confirms execution started. The cat-level
 * `catStatuses` map is deliberately NOT consulted — it is sticky across turns
 * and a stale `streaming`/`suspected_stall` value from a previous invocation
 * would suppress the new invocation's placeholder (and its tips) from the
 * first frame.
 */
export function hasInvocationStartedExecuting(
  invocation: PendingMemberInvocation,
  info: CatInvocationInfo | undefined,
): boolean {
  const lifecycle = info?.appServerLifecycle;
  if (!lifecycle) return false;
  const normalized = normalizeActiveInvocationId(invocation.invocationId, invocation.catId);
  const bound =
    info.invocationId === invocation.invocationId ||
    info.invocationId === normalized ||
    info.turnInvocationId === invocation.invocationId ||
    info.turnInvocationId === normalized;
  return bound && EXECUTING_LIFECYCLE_STAGES.has(lifecycle.stage);
}

function addVisibleInvocationIds(message: ChatMessage, visible: Set<string>): void {
  if (message.type !== 'assistant' || !message.catId || message.extra?.isExplicitPost) return;

  const parentInvocationId = message.extra?.stream?.invocationId;
  const turnInvocationId = message.extra?.stream?.turnInvocationId;
  if (parentInvocationId) visible.add(`${message.catId}:${parentInvocationId}`);
  if (turnInvocationId) visible.add(`${message.catId}:${turnInvocationId}`);
  for (const execution of message.extra?.auxiliaryTurnExecutions ?? []) {
    visible.add(`${message.catId}:${execution.invocationId}`);
  }

  if (message.id.startsWith('draft-')) {
    visible.add(`${message.catId}:${message.id.slice('draft-'.length)}`);
  }
}

/**
 * Project a pending avatar only until that exact active invocation has a real
 * assistant bubble. A later user message must not reset the association.
 */
export function derivePendingMemberInvocations(
  activeInvocations: ActiveInvocationSlots,
  messages: readonly ChatMessage[],
): PendingMemberInvocation[] {
  const visibleInvocations = new Set<string>();
  for (const message of messages) addVisibleInvocationIds(message, visibleInvocations);

  return Object.entries(activeInvocations)
    .filter(([invocationId]) => !invocationId.startsWith('hydrated-'))
    .filter(([invocationId, invocation]) => {
      const normalizedInvocationId = normalizeActiveInvocationId(invocationId, invocation.catId);
      return (
        !visibleInvocations.has(`${invocation.catId}:${invocationId}`) &&
        !visibleInvocations.has(`${invocation.catId}:${normalizedInvocationId}`)
      );
    })
    .map(([invocationId, invocation]) => ({ invocationId, catId: invocation.catId }));
}
