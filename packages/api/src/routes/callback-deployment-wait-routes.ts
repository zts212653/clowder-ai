import {
  type DeploymentAwaitStateV1,
  type DeploymentObservationV1,
  type DeploymentWaitMatchedEvidenceV1,
  type DeploymentWaitPredicate,
  deploymentWaitPredicateSchema,
  type TaskItem,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ManagedHoldDispositionService } from '../domains/ball-custody/ManagedHoldDispositionService.js';
import { createTypedWaitRegistration } from '../domains/ball-custody/TypedWaitRegistration.js';
import type {
  InvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { deploymentWaitGeneration } from '../domains/cats/services/stores/ports/TaskDeploymentWaitState.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { DeploymentWaitLifecycleService } from '../domains/runtime-deployment/DeploymentWaitLifecycleService.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { captureTypedWaitSource } from './callback-typed-wait-source.js';

const deploymentIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);

const schema = z
  .object({
    taskId: z.string().min(1),
    deploymentId: deploymentIdSchema,
    when: deploymentWaitPredicateSchema,
    nextStep: z.string().trim().min(1).max(500),
  })
  .strict();

export interface DeploymentObservationProvider {
  observe(input: {
    readonly deploymentId: string;
    readonly targetRevision?: string;
  }): Promise<DeploymentObservationV1 | null>;
}

export interface DeploymentWaitCallbackRouteDeps {
  readonly taskStore: ITaskStore;
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly registry: Pick<InvocationRegistry, 'isLatest'>;
  readonly observationProvider: DeploymentObservationProvider;
  readonly lifecycleHolder: {
    current?: Pick<DeploymentWaitLifecycleService, 'observe' | 'releaseCurrentExecutionClaim'>;
  };
  readonly managedHoldDispositionService?: Partial<Pick<ManagedHoldDispositionService, 'describe'>>;
}

type RegistrationInput = z.infer<typeof schema>;
type RouteResult = { readonly statusCode: number; readonly body: unknown };

function result(statusCode: number, body: unknown): RouteResult {
  return { statusCode, body };
}

function sameServices(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function samePredicate(left: DeploymentWaitPredicate, right: DeploymentWaitPredicate): boolean {
  if (left.kind !== right.kind || !sameServices(left.services, right.services)) return false;
  if (left.kind === 'new_ready_boot') return true;
  return right.kind === 'revision_included' && left.revision === right.revision;
}

function sameMatchedPredicate(match: DeploymentWaitMatchedEvidenceV1, predicate: DeploymentWaitPredicate): boolean {
  if (match.kind !== predicate.kind || !sameServices(match.services, predicate.services)) return false;
  return predicate.kind === 'new_ready_boot' || match.targetRevision === predicate.revision;
}

function sameRegistration(
  active: DeploymentAwaitStateV1,
  subjectRef: string,
  predicate: DeploymentWaitPredicate,
  nextStep: string,
): boolean {
  return (
    active.subjectRef === subjectRef &&
    active.continuation.then === nextStep &&
    active.continuation.when.length === 1 &&
    !!active.continuation.when[0] &&
    samePredicate(active.continuation.when[0], predicate)
  );
}

function registrationTaskError(task: TaskItem | null, auth: InvocationRecord): RouteResult | null {
  if (!task) return result(404, { error: 'Task not found' });
  if (
    task.kind !== 'work' ||
    task.userId !== auth.userId ||
    task.threadId !== auth.threadId ||
    task.ownerCatId !== auth.catId
  ) {
    return result(403, { error: 'Deployment wait must be registered by the original Task owner in its thread' });
  }
  if (task.status === 'done' || (task.entrustedWork && task.entrustedWork.closure.state !== 'open')) {
    return result(409, { error: 'Terminal Task cannot register a deployment wait' });
  }
  return null;
}

function replayResult(input: {
  readonly task: TaskItem;
  readonly auth: InvocationRecord;
  readonly sourceMessageId: string;
  readonly observation: DeploymentObservationV1;
  readonly registration: RegistrationInput;
  readonly receiptInvocationId?: string;
  readonly receiptSourceMessageId?: string;
}): RouteResult | null {
  const { task, auth, sourceMessageId, observation, registration } = input;
  const prior = task.deploymentWait;
  const sameSource =
    input.receiptInvocationId === auth.invocationId && input.receiptSourceMessageId === sourceMessageId;
  if (
    prior?.await &&
    sameSource &&
    sameRegistration(prior.await, observation.subjectRef, registration.when, registration.nextStep)
  ) {
    return result(200, { status: 'ok', disposition: 'already_registered', task, await: prior.await });
  }
  const match = prior?.waitOutcome?.deploymentMatch;
  if (
    prior?.waitOutcome &&
    match &&
    sameSource &&
    sameMatchedPredicate(match, registration.when) &&
    prior.waitOutcome.subjectRef === observation.subjectRef &&
    prior.waitOutcome.nextStep === registration.nextStep
  ) {
    return result(200, { status: 'ok', disposition: 'already_satisfied', task, outcome: prior.waitOutcome });
  }
  return prior?.waitOutcome?.delivery === 'pending'
    ? result(409, { error: 'Deployment wait has a pending delivery; retry after recovery' })
    : null;
}

function buildAwaitState(
  registration: RegistrationInput,
  observation: DeploymentObservationV1,
  generation: number,
): DeploymentAwaitStateV1 {
  return {
    v: 1,
    generation,
    subjectRef: observation.subjectRef,
    ownerFence: { kind: 'containing_task', generation },
    baseline: {
      bootSequence: observation.bootSequence,
      bootId: observation.bootId,
      capturedAt: observation.observedAt,
    },
    continuation: {
      when: [registration.when],
      // biome-ignore lint/suspicious/noThenProperty: F280 contract field.
      then: registration.nextStep,
    },
    autoRenew: false,
    createdAt: Date.now(),
  };
}

async function performRegistration(
  registration: RegistrationInput,
  auth: InvocationRecord,
  lifecycle: Pick<DeploymentWaitLifecycleService, 'observe' | 'releaseCurrentExecutionClaim'>,
  deps: DeploymentWaitCallbackRouteDeps,
): Promise<RouteResult> {
  const task = await deps.taskStore.get(registration.taskId);
  const taskError = registrationTaskError(task, auth);
  if (taskError || !task) return taskError ?? result(404, { error: 'Task not found' });

  const targetRevision = registration.when.kind === 'revision_included' ? registration.when.revision : undefined;
  const observe = () =>
    deps.observationProvider.observe({
      deploymentId: registration.deploymentId,
      ...(targetRevision ? { targetRevision } : {}),
    });
  const observation = await observe();
  if (!observation) return result(503, { error: 'Deployment baseline is unavailable; no wait was registered' });

  const source = await captureTypedWaitSource(auth, {
    messageStore: deps.messageStore,
    ...(deps.managedHoldDispositionService
      ? { managedHoldDispositionService: deps.managedHoldDispositionService }
      : {}),
  });
  if (!source) return result(409, { error: 'Invocation source is unavailable; no wait was registered' });

  const snapshot = await deps.taskStore.getWaitRegistration(task.id);
  const replay = replayResult({
    task,
    auth,
    sourceMessageId: source.sourceMessageId,
    observation,
    registration,
    receiptInvocationId: snapshot?.receipt?.invocationId,
    receiptSourceMessageId: snapshot?.receipt?.source.sourceMessageId,
  });
  if (replay) return replay;

  const previousGeneration = deploymentWaitGeneration(task.deploymentWait) ?? 0;
  const awaitState = buildAwaitState(registration, observation, previousGeneration + 1);
  const receipt = createTypedWaitRegistration({ task, active: awaitState, invocationId: auth.invocationId, source });
  if (!receipt || !(await deps.registry.isLatest(auth.invocationId))) {
    return result(409, { error: 'Invocation no longer owns deployment wait registration' });
  }
  const installed = await deps.taskStore.replaceDeploymentWaitIfGeneration(task.id, {
    expectedGeneration: previousGeneration === 0 ? null : previousGeneration,
    expectedDeploymentWait: task.deploymentWait,
    expectedUpdatedAt: task.updatedAt,
    deploymentWait: {
      await: awaitState,
      currentExecutionClaim: {
        invocationId: auth.invocationId,
        generation: awaitState.generation,
        bootId: observation.bootId,
      },
    },
    waitRegistration: receipt,
    status: 'blocked',
  });
  if (!installed) return result(409, { error: 'Deployment wait changed concurrently; retry registration' });

  let immediate;
  try {
    immediate = await lifecycle.observe({
      taskId: installed.id,
      observation: (await observe()) ?? observation,
      currentInvocationId: auth.invocationId,
      wakeOwner: false,
    });
  } finally {
    // A non-match releases first-consumer priority; a matched outcome clears
    // only after that invocation terminates, so a crash can re-arm delivery.
    if (immediate?.kind !== 'notified') {
      await lifecycle.releaseCurrentExecutionClaim(installed.id, auth.invocationId);
    }
  }
  return result(200, {
    status: 'ok',
    disposition: immediate.kind === 'notified' ? 'matched_current_execution' : 'registered',
    task: await deps.taskStore.get(installed.id),
    await: awaitState,
    observationState: immediate.kind,
  });
}

async function registrationHandler(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: DeploymentWaitCallbackRouteDeps,
): Promise<unknown> {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400);
    return { error: 'Invalid request body', details: parsed.error.issues };
  }
  const auth = requireCallbackAuth(request, reply);
  if (!auth) return;
  const lifecycle = deps.lifecycleHolder.current;
  if (!lifecycle) {
    reply.status(503);
    return { error: 'Deployment wait lifecycle is not ready; no wait was registered' };
  }
  const handled = await performRegistration(parsed.data, auth, lifecycle, deps);
  reply.status(handled.statusCode);
  return handled.body;
}

export function registerCallbackDeploymentWaitRoutes(
  app: FastifyInstance,
  deps: DeploymentWaitCallbackRouteDeps,
): void {
  app.post('/api/callbacks/register-deployment-wait', (request, reply) => registrationHandler(request, reply, deps));
}
