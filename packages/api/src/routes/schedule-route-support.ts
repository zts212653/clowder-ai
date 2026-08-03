import type { FastifyRequest } from 'fastify';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type {
  InvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { resolveCatTarget } from '../domains/cats/services/agents/routing/cat-target-resolver.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { DynamicTaskDef, DynamicTaskStore } from '../infrastructure/scheduler/DynamicTaskStore.js';
import type { GlobalControlStore } from '../infrastructure/scheduler/GlobalControlStore.js';
import type { PackTemplateStore } from '../infrastructure/scheduler/PackTemplateStore.js';
import type { ScheduleMutationProposalStore } from '../infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { computeSubjectPreview, type TaskRunnerV2 } from '../infrastructure/scheduler/TaskRunnerV2.js';
import type { ScheduleLifecycleNotifier, ScheduleTaskSummary, TriggerSpec } from '../infrastructure/scheduler/types.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';
import type { AgentKeyAuthRegistry } from './callback-auth-prehandler.js';
import {
  deriveCallbackActor,
  getDeletedCallbackThreadGuard,
  resolvePrincipalThread,
} from './callback-scope-helpers.js';
import { isRetiredHoldBallTombstone } from './hold-ball-cancel.js';
import type { ScheduleMutationPrincipal } from './schedule-mutation-principal.js';

export interface ScheduleRoutesOptions {
  taskRunner: TaskRunnerV2;
  dynamicTaskStore?: DynamicTaskStore;
  templateRegistry?: {
    get: (id: string) => import('../infrastructure/scheduler/templates/types.js').TaskTemplate | null;
    list: () => import('../infrastructure/scheduler/templates/types.js').TaskTemplate[];
    register?: (template: import('../infrastructure/scheduler/templates/types.js').TaskTemplate) => void;
    unregister?: (templateId: string) => boolean;
  };
  globalControlStore?: GlobalControlStore;
  packTemplateStore?: PackTemplateStore;
  taskStore?: ITaskStore;
  threadStore?: IThreadStore;
  notifyLifecycle?: ScheduleLifecycleNotifier;
  registry?: InvocationRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
  ownerUserId?: string;
  scheduleMutationProposalStore?: ScheduleMutationProposalStore;
  approvalIngress?: Pick<ApprovalIngress, 'publish'>;
}

export function normalizeOnceTrigger(trigger: Record<string, unknown>): TriggerSpec | { error: string } {
  if (trigger.type !== 'once') return trigger as TriggerSpec;
  const delayMs = typeof trigger.delayMs === 'number' ? trigger.delayMs : undefined;
  const fireAt = typeof trigger.fireAt === 'number' ? trigger.fireAt : undefined;
  if (delayMs != null) {
    if (!Number.isFinite(delayMs) || delayMs < 0) return { error: 'once trigger delayMs must be a finite number >= 0' };
    return { type: 'once', fireAt: Date.now() + delayMs };
  }
  if (fireAt != null) {
    if (!Number.isFinite(fireAt) || fireAt < 0) {
      return { error: 'once trigger fireAt must be a finite positive epoch ms' };
    }
    return { type: 'once', fireAt };
  }
  return { error: 'once trigger requires either delayMs or fireAt' };
}

export function extractThreadId(subjectKey: string): string | null {
  if (subjectKey.startsWith('thread-')) return subjectKey.slice(7);
  if (subjectKey.startsWith('thread:')) return subjectKey.slice(7);
  return null;
}

export function addSubjectKeyWithAliases(target: Set<string>, subjectKey: string): void {
  target.add(subjectKey);
  if (subjectKey.startsWith('pr:')) target.add(`pr-${subjectKey.slice(3)}`);
  if (subjectKey.startsWith('pr-')) target.add(`pr:${subjectKey.slice(3)}`);
}

function buildUnregisteredDynamicTaskSummary(
  def: DynamicTaskDef,
  taskRunner: TaskRunnerV2,
  templateRegistry: ScheduleRoutesOptions['templateRegistry'],
): ScheduleTaskSummary {
  const template = templateRegistry?.get(def.templateId) ?? null;
  const spec = template?.createSpec(def.id, {
    trigger: def.trigger,
    params: def.params,
    deliveryThreadId: def.deliveryThreadId,
  });
  const display = spec?.display ? { ...spec.display, ...def.display } : def.display;
  const ledger = taskRunner.getLedger();
  const lastRun = ledger.query(def.id, 1)[0] ?? null;
  return {
    id: def.id,
    profile: spec?.profile ?? 'awareness',
    trigger: def.trigger,
    enabled: def.enabled,
    effectiveEnabled: false,
    actor: spec?.actor,
    context: spec?.context,
    lastRun,
    runStats: ledger.stats(def.id),
    display,
    subjectPreview: computeSubjectPreview(display.subjectKind, lastRun),
    source: 'dynamic',
    dynamicTaskId: def.id,
    deliveryThreadId: def.deliveryThreadId,
    registered: false,
  };
}

export function mergeUnregisteredDynamicTasks(
  summaries: ScheduleTaskSummary[],
  taskRunner: TaskRunnerV2,
  dynamicTaskStore: DynamicTaskStore | undefined,
  templateRegistry: ScheduleRoutesOptions['templateRegistry'],
): ScheduleTaskSummary[] {
  if (!dynamicTaskStore) return summaries;
  const dynamicDefs = dynamicTaskStore.getAll();
  const hiddenDynamicIds = new Set(dynamicDefs.filter(isRetiredHoldBallTombstone).map((def) => def.id));
  const visibleDynamicDefs = dynamicDefs.filter((def) => !hiddenDynamicIds.has(def.id));
  const defsById = new Map(visibleDynamicDefs.map((def) => [def.id, def]));
  const summariesWithDynamicScope = summaries
    .filter((summary) => !hiddenDynamicIds.has(summary.dynamicTaskId ?? summary.id))
    .map((summary) => {
      const def = summary.dynamicTaskId ? defsById.get(summary.dynamicTaskId) : defsById.get(summary.id);
      if (!def) return summary;
      return { ...summary, deliveryThreadId: def.deliveryThreadId };
    });
  const registeredIds = new Set(summariesWithDynamicScope.map((summary) => summary.id));
  const unregistered = visibleDynamicDefs
    .filter((def) => !registeredIds.has(def.id))
    .map((def) => buildUnregisteredDynamicTaskSummary(def, taskRunner, templateRegistry));
  return [...summariesWithDynamicScope, ...unregistered];
}

export function isVisibleDynamicTaskDef(def: DynamicTaskDef | null | undefined): def is DynamicTaskDef {
  return !!def && !isRetiredHoldBallTombstone(def);
}

export function isF255ManagedTask(def: DynamicTaskDef): boolean {
  return def.templateId === 'present-loop' && def.params.managedBy === 'f255-cat-life';
}

export function f255ManagedTask() {
  return {
    error: 'This Present Loop projection is managed by F255 cat-life settings; change it from /starry',
    code: 'F255_MANAGED_TASK',
  };
}

type DeliveryThreadResolutionCode = 'STALE_INVOCATION';

interface ScheduleActor {
  triggerUserId: string;
  createdBy: string;
}

export async function resolveScopedDeliveryThreadId(
  callbackAuth: InvocationRecord | undefined,
  body: { deliveryThreadId?: string },
  registry?: InvocationRegistry,
): Promise<{ deliveryThreadId: string | null; code: DeliveryThreadResolutionCode | null }> {
  if (!callbackAuth) {
    return { deliveryThreadId: body.deliveryThreadId ?? null, code: null };
  }
  if (registry && !(await registry.isLatest(callbackAuth.invocationId))) {
    return { deliveryThreadId: null, code: 'STALE_INVOCATION' };
  }
  if (body.deliveryThreadId) return { deliveryThreadId: body.deliveryThreadId, code: null };
  return { deliveryThreadId: callbackAuth.threadId, code: null };
}

export async function resolveAgentKeyDeliveryThreadScope(
  request: FastifyRequest,
  deliveryThreadId: string | null,
  threadStore: Pick<IThreadStore, 'get' | 'list'> | undefined,
): Promise<{ ok: true } | { ok: false; statusCode: 400 | 403 | 410 | 503; error: string; code?: 'THREAD_DELETED' }> {
  const principal = request.callbackPrincipal;
  if (principal?.kind !== 'agent_key') return { ok: true };
  if (!deliveryThreadId) {
    return {
      ok: false,
      statusCode: 400,
      error:
        'deliveryThreadId is required for agent-key schedule registration because persistent agent-key calls have no invocation thread',
    };
  }
  const scoped = await resolvePrincipalThread(principal, deliveryThreadId, {
    threadStore,
    threadStoreMissingError: 'Thread store not configured for agent-key deliveryThreadId scope',
    accessDeniedError: 'deliveryThreadId is not visible to the agent-key user',
  });
  if (!scoped.ok) return scoped;
  const deletedThreadGuard = await getDeletedCallbackThreadGuard(threadStore, deliveryThreadId);
  if (deletedThreadGuard) {
    return {
      ok: false,
      statusCode: deletedThreadGuard.statusCode,
      error: deletedThreadGuard.body.error,
      code: deletedThreadGuard.body.code,
    };
  }
  return { ok: true };
}

function deriveScheduleActor(request: FastifyRequest, _body: { createdBy?: string }): ScheduleActor {
  const principal = request.callbackPrincipal;
  if (principal?.kind === 'agent_key') {
    return { triggerUserId: principal.userId, createdBy: principal.catId };
  }
  if (request.callbackAuth) {
    const actor = deriveCallbackActor(request.callbackAuth);
    return { triggerUserId: actor.userId, createdBy: actor.catId };
  }
  return {
    triggerUserId: resolveHeaderUserId(request) ?? 'default-user',
    createdBy: 'user',
  };
}

export function toPlainScheduleParams(params: unknown): Record<string, unknown> | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  return params as Record<string, unknown>;
}

export function deriveScheduleRequestContext(
  request: FastifyRequest,
  body: { createdBy?: string },
  rawParams: Record<string, unknown>,
  mutationPrincipal?: ScheduleMutationPrincipal,
): { actor: ScheduleActor; params: Record<string, unknown> } {
  const actor = mutationPrincipal
    ? mutationPrincipal.kind === 'cvo'
      ? { triggerUserId: mutationPrincipal.userId, createdBy: 'user' }
      : { triggerUserId: mutationPrincipal.userId, createdBy: mutationPrincipal.catId }
    : deriveScheduleActor(request, body);
  const params: Record<string, unknown> = { ...rawParams, triggerUserId: actor.triggerUserId };
  if (!params.targetCatId && request.callbackPrincipal?.kind === 'agent_key') {
    params.targetCatId = request.callbackPrincipal.catId;
  }
  return { actor, params };
}

export function normalizeScheduleTargetParam(
  params: Record<string, unknown>,
): { ok: true; params: Record<string, unknown> } | { ok: false; error: unknown } {
  if (params.targetCatId && typeof params.targetCatId === 'string') {
    const resolved = resolveCatTarget(params.targetCatId);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    return { ok: true, params: { ...params, targetCatId: resolved.ok } };
  }
  return { ok: true, params };
}

export function deriveScheduleActorForTest(request: FastifyRequest, body: { createdBy?: string }): ScheduleActor {
  return deriveScheduleActor(request, body);
}
