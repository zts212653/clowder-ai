import { asCodexAppServerRecord, type CodexAppServerJsonObject } from './CodexAppServerEventMapper.js';
import {
  type CodexSubexecutionEvent,
  createCodexSubexecutionEvent,
  createCodexSubexecutionIdentity,
  exactCodexCoordinate as exactCoordinate,
  type CodexSubexecutionIdentity as SubexecutionIdentity,
} from './CodexSubexecutionIdentity.js';

type JsonObject = CodexAppServerJsonObject;

interface RootBinding {
  readonly threadId: string;
  readonly turnId: string;
}

export interface CodexSubexecutionObservation {
  readonly scope: 'root' | 'child' | 'foreign';
  readonly event?: CodexSubexecutionEvent;
}

export interface CodexSubexecutionTracker {
  observe(envelope: unknown): Promise<CodexSubexecutionObservation>;
}

interface CodexSubexecutionTrackerOptions {
  readonly binding: RootBinding;
  readonly readThread: (threadId: string) => Promise<unknown>;
  readonly now?: () => number;
}

interface TrackerState {
  readonly children: Map<string, SubexecutionIdentity>;
  readonly emittedEvents: Set<string>;
  readonly invalidChildren: Set<string>;
  readonly activityOwners: Map<string, string>;
}

interface ParsedNotification {
  readonly record: JsonObject;
  readonly params: JsonObject;
  readonly method: string;
  readonly threadId: string | null;
  readonly turnId: string | null;
}

interface KnownNotification extends ParsedNotification {
  readonly scope: 'root' | 'child';
  readonly identity: SubexecutionIdentity;
}

/** Join root `subAgentActivity` items to child notifications on the same run. */
export function createCodexSubexecutionTracker(options: CodexSubexecutionTrackerOptions): CodexSubexecutionTracker {
  const state: TrackerState = {
    children: new Map(),
    emittedEvents: new Set(),
    invalidChildren: new Set(),
    activityOwners: new Map(),
  };
  const now = options.now ?? Date.now;

  return {
    observe: (envelope) => observeEnvelope(envelope, options, state, now),
  };
}

async function observeEnvelope(
  envelope: unknown,
  options: CodexSubexecutionTrackerOptions,
  state: TrackerState,
  now: () => number,
): Promise<CodexSubexecutionObservation> {
  const notification = parseNotification(envelope);
  if (!notification) return { scope: 'root' };
  if (!notification.threadId) {
    return { scope: isTurnScoped(notification.method) ? 'foreign' : 'root' };
  }
  const known = resolveKnownNotification(notification, options.binding, state);
  if (!known || !matchesKnownTurn(known, options.binding)) return { scope: 'foreign' };
  return observeKnownNotification(known, options.readThread, state, now);
}

function parseNotification(envelope: unknown): ParsedNotification | null {
  const record = asCodexAppServerRecord(envelope);
  const params = asCodexAppServerRecord(record?.params);
  const method = record?.method;
  if (!record || !params || typeof method !== 'string') return null;
  return {
    record,
    params,
    method,
    threadId: exactCoordinate(params.threadId),
    turnId: notificationTurnId(params),
  };
}

function resolveKnownNotification(
  notification: ParsedNotification,
  binding: RootBinding,
  state: TrackerState,
): KnownNotification | null {
  if (notification.threadId === binding.threadId) {
    return { ...notification, scope: 'root', identity: rootIdentity(binding) };
  }
  const childId = notification.threadId;
  if (!childId || state.invalidChildren.has(childId)) return null;
  const child = state.children.get(childId);
  return child ? { ...notification, scope: 'child', identity: child } : null;
}

function matchesKnownTurn(notification: KnownNotification, binding: RootBinding): boolean {
  if (!isTurnScoped(notification.method)) return true;
  if (!notification.turnId) return false;
  if (notification.scope === 'root') return notification.turnId === binding.turnId;
  if (notification.method === 'turn/started' && !notification.identity.activeTurnId) return true;
  return notification.turnId === notification.identity.activeTurnId;
}

async function observeKnownNotification(
  notification: KnownNotification,
  readThread: (threadId: string) => Promise<unknown>,
  state: TrackerState,
  now: () => number,
): Promise<CodexSubexecutionObservation> {
  const activity = startedSubAgentActivity(notification);
  if (activity) {
    const event = await admitChild(activity, notification, readThread, state, now);
    return event ? { scope: notification.scope, event } : { scope: notification.scope };
  }
  if (notification.scope === 'root') return { scope: 'root' };
  const event = observeChildNotification(notification.record, notification.params, notification.identity, now);
  return emitOnce(notification.scope, event, state.emittedEvents);
}

function startedSubAgentActivity(notification: KnownNotification): JsonObject | null {
  if (notification.method !== 'item/started' || notification.turnId !== notification.identity.activeTurnId) return null;
  const item = asCodexAppServerRecord(notification.params.item);
  return item?.type === 'subAgentActivity' && item.kind === 'started' ? item : null;
}

async function admitChild(
  activity: JsonObject,
  notification: KnownNotification,
  readThread: (threadId: string) => Promise<unknown>,
  state: TrackerState,
  now: () => number,
): Promise<CodexSubexecutionEvent | null> {
  if (isExactActivityReplay(activity, notification, state.children)) return null;
  const child = await createCodexSubexecutionIdentity({
    activity,
    parent: notification.identity,
    params: notification.params,
    readThread,
  });
  if (!child || state.invalidChildren.has(child.subexecutionId)) return null;
  const activityOwner = state.activityOwners.get(child.activityId);
  const existing = state.children.get(child.subexecutionId);
  if ((activityOwner && activityOwner !== child.subexecutionId) || (existing && !sameIdentity(existing, child))) {
    invalidateIdentityCollision(child, activityOwner, state);
    return null;
  }
  if (existing) return null;
  state.children.set(child.subexecutionId, child);
  state.activityOwners.set(child.activityId, child.subexecutionId);
  const event = createCodexSubexecutionEvent(child, {
    eventId: subexecutionEventId('started', child.subexecutionId, child.activityId),
    occurredAt: emittedAt(notification.record, now),
    stage: 'started',
  });
  state.emittedEvents.add(event.event_id);
  return event;
}

function isExactActivityReplay(
  activity: JsonObject,
  notification: KnownNotification,
  children: Map<string, SubexecutionIdentity>,
): boolean {
  const childId = exactCoordinate(activity.agentThreadId);
  const existing = childId ? children.get(childId) : undefined;
  return Boolean(
    existing &&
      exactCoordinate(activity.id) === existing.activityId &&
      activity.agentPath === existing.agentPath &&
      notification.identity.subexecutionId === existing.parentExecutionId &&
      notification.identity.rootExecutionId === existing.rootExecutionId &&
      notification.identity.rootTurnId === existing.rootTurnId &&
      exactCoordinate(notification.params.turnId) === existing.parentTurnId,
  );
}

function invalidateIdentityCollision(
  child: SubexecutionIdentity,
  activityOwner: string | undefined,
  state: TrackerState,
): void {
  state.invalidChildren.add(child.subexecutionId);
  state.children.delete(child.subexecutionId);
  if (activityOwner) {
    state.invalidChildren.add(activityOwner);
    state.children.delete(activityOwner);
  }
}

function sameIdentity(left: SubexecutionIdentity, right: SubexecutionIdentity): boolean {
  return (
    left.activityId === right.activityId &&
    left.parentExecutionId === right.parentExecutionId &&
    left.parentTurnId === right.parentTurnId &&
    left.agentPath === right.agentPath &&
    left.depth === right.depth &&
    left.nickname === right.nickname
  );
}

function emitOnce(
  scope: 'root' | 'child',
  event: CodexSubexecutionEvent | null,
  emittedEvents: Set<string>,
): CodexSubexecutionObservation {
  if (!event || emittedEvents.has(event.event_id)) return { scope };
  emittedEvents.add(event.event_id);
  return { scope, event };
}

export function isExactCodexRootTurnCompletion(envelope: unknown, binding: RootBinding): boolean {
  const record = asCodexAppServerRecord(envelope);
  if (record?.method !== 'turn/completed') return false;
  const params = asCodexAppServerRecord(record.params);
  const turn = asCodexAppServerRecord(params?.turn);
  return params?.threadId === binding.threadId && turn?.id === binding.turnId;
}

function rootIdentity(binding: RootBinding): SubexecutionIdentity {
  return {
    activityId: 'root',
    subexecutionId: binding.threadId,
    rootExecutionId: binding.threadId,
    parentExecutionId: binding.threadId,
    rootTurnId: binding.turnId,
    parentTurnId: binding.turnId,
    agentPath: '/root',
    depth: 0,
    activeTurnId: binding.turnId,
  };
}

function observeChildNotification(
  record: JsonObject,
  params: JsonObject,
  child: SubexecutionIdentity,
  now: () => number,
): CodexSubexecutionEvent | null {
  const method = record.method;
  if (method === 'turn/started') {
    const turnId = notificationTurnId(params);
    if (!turnId || (child.activeTurnId && child.activeTurnId !== turnId)) return null;
    child.activeTurnId = turnId;
    return null;
  }
  const turnId = notificationTurnId(params);
  if (!turnId || turnId !== child.activeTurnId) return null;

  if (method === 'item/completed') {
    const item = asCodexAppServerRecord(params.item);
    const itemId = exactCoordinate(item?.id);
    const content = nonBlankText(item?.text);
    if (item?.type !== 'agentMessage' || !itemId || !content) return null;
    return createCodexSubexecutionEvent(child, {
      eventId: subexecutionEventId('message', child.subexecutionId, turnId, itemId),
      occurredAt: emittedAt(record, now),
      stage: 'message',
      turnId,
      content,
      messagePhase: messagePhase(item.phase),
    });
  }

  if (method !== 'turn/completed') return null;
  const turn = asCodexAppServerRecord(params.turn);
  const stage = terminalStage(turn?.status);
  if (!stage) return null;
  child.activeTurnId = null;
  return createCodexSubexecutionEvent(child, {
    eventId: subexecutionEventId('terminal', child.subexecutionId, turnId),
    occurredAt: emittedAt(record, now),
    stage,
    turnId,
  });
}

function subexecutionEventId(kind: 'started' | 'message' | 'terminal', ...coordinates: string[]): string {
  return `subexecution:codex:${kind}:${coordinates.map((coordinate) => `${coordinate.length}:${coordinate}`).join('')}`;
}

function notificationTurnId(params: JsonObject): string | null {
  const direct = exactCoordinate(params.turnId);
  if (direct) return direct;
  return exactCoordinate(asCodexAppServerRecord(params.turn)?.id);
}

function isTurnScoped(method: string): boolean {
  return method.startsWith('item/') || method.startsWith('turn/');
}

function terminalStage(value: unknown): CodexSubexecutionEvent['stage'] | null {
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  if (value === 'interrupted') return 'interrupted';
  return null;
}

function messagePhase(value: unknown): 'commentary' | 'final_answer' | 'unknown' {
  return value === 'commentary' || value === 'final_answer' ? value : 'unknown';
}

function emittedAt(record: JsonObject, now: () => number): number {
  return typeof record.emittedAtMs === 'number' && Number.isFinite(record.emittedAtMs) ? record.emittedAtMs : now();
}

function nonBlankText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
