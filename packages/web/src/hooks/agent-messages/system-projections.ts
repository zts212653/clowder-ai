import { resolveProviderSemanticMessage } from '@/lib/provider-semantic-registry';
import type {
  AppServerLifecycleSnapshot,
  AppServerLifecycleStage,
  CatStatusType,
  ChatMessage,
  ChatMessagePatch,
  LivenessWarningSnapshot,
  ProviderCapabilityReport,
  SystemInfoProjection,
} from '@/stores/chat-types';
import type { AgentEventFields } from './types';

/** Pure projections from protocol payloads to status snapshots and system rows (both entry points). */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Where system rows (rows with their own ids, never a response) land: the open thread binds this to
 * its gated flat writers in the hook shell, a background thread to its thread-scoped writers.
 */
export interface SystemRowSink {
  rows(): readonly ChatMessage[];
  addRow(row: ChatMessage): void;
  patchRow(id: string, patch: ChatMessagePatch): void;
}

export function patchForProjectedSystemMessage(message: ChatMessage): ChatMessagePatch {
  return {
    variant: message.variant,
    catId: message.catId,
    content: message.content,
    timestamp: message.timestamp,
    extra: message.extra,
  };
}

/** A row with its own id is created once and updated in place afterwards. */
export function upsertSystemRow(
  sink: SystemRowSink,
  row: ChatMessage,
  patch: ChatMessagePatch = patchForProjectedSystemMessage(row),
): void {
  if (sink.rows().some((message) => message.id === row.id)) sink.patchRow(row.id, patch);
  else sink.addRow(row);
}

const APP_SERVER_LIFECYCLE_STAGES = new Set<AppServerLifecycleStage>([
  'child_spawned',
  'initialized',
  'thread_ready',
  'turn_accepted',
  'active',
  'completed',
  'interrupted',
  'failed',
  'closing',
  'closed',
]);

export function parseAppServerLifecycle(value: Record<string, unknown>): AppServerLifecycleSnapshot | null {
  if (typeof value.stage !== 'string' || !APP_SERVER_LIFECYCLE_STAGES.has(value.stage as AppServerLifecycleStage)) {
    return null;
  }
  if (
    typeof value.lastActivityAt !== 'number' ||
    typeof value.recoveryAttempt !== 'number' ||
    typeof value.turnStartSent !== 'boolean' ||
    typeof value.turnAccepted !== 'boolean' ||
    typeof value.itemObserved !== 'boolean'
  ) {
    return null;
  }
  return {
    stage: value.stage as AppServerLifecycleStage,
    lastActivityAt: value.lastActivityAt,
    recoveryAttempt: value.recoveryAttempt,
    turnStartSent: value.turnStartSent,
    turnAccepted: value.turnAccepted,
    itemObserved: value.itemObserved,
    ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
    ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
    ...(value.interruptReason === 'user_cancel' || value.interruptReason === 'timeout'
      ? { interruptReason: value.interruptReason }
      : {}),
    ...(typeof value.failureReason === 'string' ? { failureReason: value.failureReason } : {}),
    ...(typeof value.cleanupError === 'string' ? { cleanupError: value.cleanupError } : {}),
  };
}

export function appServerStageStatus(stage: AppServerLifecycleStage): CatStatusType | undefined {
  if (stage === 'child_spawned' || stage === 'initialized' || stage === 'thread_ready') return 'spawning';
  if (stage === 'turn_accepted' || stage === 'active') return 'streaming';
  if (stage === 'failed') return 'error';
  if (stage === 'completed' || stage === 'interrupted') return 'done';
  return undefined;
}

type StatusDiagnostics = { diagnostics?: Record<string, unknown> } | undefined;

export function appServerLifecycleFromStatus(metadata: StatusDiagnostics): AppServerLifecycleSnapshot | null {
  const value = metadata?.diagnostics?.appServerLifecycle;
  return isRecord(value) ? parseAppServerLifecycle(value) : null;
}

export function isAppServerRecoveryStatus(metadata: StatusDiagnostics): boolean {
  return isRecord(metadata?.diagnostics?.appServerRecovery);
}

export function retainSystemInfo(payload: Record<string, unknown>, fallbackCatId: string): SystemInfoProjection {
  return { v: 1, payload, fallbackCatId };
}

type ContextBriefingStoredMessage = { id: string; content: string; timestamp: number; extra?: ChatMessage['extra'] };

/** F148: the persisted typed briefing card keeps its stored id. */
export function projectContextBriefingMessage(parsed: Record<string, unknown>): ChatMessage | null {
  const storedMessage = parsed.storedMessage as ContextBriefingStoredMessage | undefined;
  if (!storedMessage?.id) return null;
  return {
    id: storedMessage.id,
    type: 'system',
    content: storedMessage.content,
    origin: 'briefing',
    timestamp: storedMessage.timestamp,
    ...(storedMessage.extra ? { extra: storedMessage.extra } : {}),
  };
}

/** Reconnect evidence belongs to the exact response, never to a second chat result. */
export function parseProviderRecovery(
  parsed: Record<string, unknown>,
  context: { invocationId?: string; turnInvocationId?: string; timestamp?: number },
): NonNullable<NonNullable<ChatMessage['extra']>['providerRecovery']> | null {
  const phase = parsed.phase;
  if (phase !== 'reconnecting' && phase !== 'recovered' && phase !== 'failed') return null;
  const invocationId = context.turnInvocationId ?? context.invocationId;
  const attempt = typeof parsed.attempt === 'number' ? parsed.attempt : undefined;
  const evidence = stringField(parsed, 'evidence');
  return {
    v: 1,
    provider: stringField(parsed, 'provider') ?? 'provider',
    phase,
    ...(invocationId ? { invocationId } : {}),
    ...(context.invocationId ? { parentInvocationId: context.invocationId } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    attempts: Array.isArray(parsed.attempts)
      ? parsed.attempts.filter((item): item is string => typeof item === 'string')
      : [],
    ...(evidence ? { evidence } : {}),
    updatedAt: context.timestamp ?? Date.now(),
  };
}

type SemanticResolution = { action: 'replace'; message: ChatMessage } | { action: 'augment' } | { action: 'suppress' };

/** F306: a provider semantic event either replaces the event with its own row, augments it, or hides it. */
export function resolveSemanticSystemMessage(
  msg: Pick<AgentEventFields, 'catId' | 'semanticEvent'> & { timestamp?: number },
): SemanticResolution {
  if (!msg.semanticEvent) return { action: 'augment' };
  const result = resolveProviderSemanticMessage(msg.semanticEvent);
  if (result.action !== 'replace') return { action: result.action };
  return {
    action: 'replace',
    message: {
      id: `semantic:${result.projection.eventId}`,
      type: 'system',
      variant: result.projection.severity === 'error' ? 'error' : 'info',
      catId: msg.catId,
      content: result.projection.content,
      timestamp: msg.semanticEvent.occurredAt ?? msg.timestamp ?? Date.now(),
      extra: { semanticEvent: msg.semanticEvent },
    },
  };
}

function nullableField<T>(value: unknown, isType: (candidate: unknown) => candidate is T): T | null | undefined {
  if (value === null) return null;
  return isType(value) ? value : undefined;
}

const isNumber = (value: unknown): value is number => typeof value === 'number';
const isString = (value: unknown): value is string => typeof value === 'string';

/** F118 Phase C: liveness warning snapshot for the cat's invocation panel. */
export function parseLivenessWarning(parsed: Record<string, unknown>): LivenessWarningSnapshot {
  return {
    level: parsed.level as LivenessWarningSnapshot['level'],
    state: parsed.state as LivenessWarningSnapshot['state'],
    silenceDurationMs: parsed.silenceDurationMs as number,
    cpuTimeMs: typeof parsed.cpuTimeMs === 'number' ? parsed.cpuTimeMs : undefined,
    processAlive: parsed.processAlive as boolean,
    firstEventAt: nullableField(parsed.firstEventAt, isNumber),
    lastEventAt: nullableField(parsed.lastEventAt, isNumber),
    lastEventType: nullableField(parsed.lastEventType, isString),
    receivedAt: Date.now(),
  };
}

/** #939: capability telemetry is stored per cat, never shown as a bubble. `||` lets an empty catId fall back. */
export function parseProviderCapability(
  parsed: Record<string, unknown>,
  fallbackCatId: string,
): { catId: string | undefined; capability: string; report: ProviderCapabilityReport } {
  const status = parsed.status;
  return {
    catId: stringField(parsed, 'catId') || fallbackCatId || undefined,
    capability: typeof parsed.capability === 'string' ? parsed.capability : 'unknown',
    report: {
      status: status === 'available' || status === 'limited' || status === 'unavailable' ? status : 'unavailable',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      provider: typeof parsed.provider === 'string' ? parsed.provider : 'unknown',
      receivedAt: Date.now(),
    },
  };
}

type GovernanceReason = NonNullable<NonNullable<ChatMessage['extra']>['governanceBlocked']>['reasonKind'];

/** F070: actionable bootstrap card; one per project path (the caller removes the previous one). */
export function governanceBlockedMessage(parsed: Record<string, unknown>, id: string, timestamp: number): ChatMessage {
  const projectPath = typeof parsed.projectPath === 'string' ? parsed.projectPath : '';
  const reasonKind = (parsed.reasonKind as GovernanceReason | undefined) ?? 'needs_bootstrap';
  return {
    id,
    type: 'system',
    variant: 'governance_blocked',
    content: `项目 ${projectPath} ${reasonKind === 'needs_bootstrap' ? '尚未初始化治理' : '治理状态异常'}`,
    timestamp,
    extra: {
      governanceBlocked: {
        projectPath,
        reasonKind,
        invocationId: typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined,
      },
    },
  };
}
