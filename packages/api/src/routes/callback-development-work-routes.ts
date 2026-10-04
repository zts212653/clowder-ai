import {
  type DevelopmentScopeV1,
  type DevelopmentWorkActionV1,
  developmentWorkActionV1Schema,
  type TaskItem,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { deriveGrowingSourceMessageRevision } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStoreContract.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { DevelopmentScopeGitDocuments } from '../domains/growing/DevelopmentScopeGitDocuments.js';
import {
  type DevelopmentScopeDocuments,
  DevelopmentScopeResolver,
} from '../domains/growing/DevelopmentScopeResolver.js';
import {
  EntrustedWorkLifecycleError,
  EntrustedWorkLifecycleService,
} from '../domains/growing/EntrustedWorkLifecycleService.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { type CallbackActor, deriveCallbackActor } from './callback-scope-helpers.js';
import { admissionSourceContext, assertDirectAdmissionSourceCustody } from './entrusted-work-source-custody.js';

interface Dependencies {
  taskStore: ITaskStore;
  messageStore: IMessageStore;
  threadStore?: IThreadStore;
  socketManager: SocketManager;
  developmentDocuments?: DevelopmentScopeDocuments;
}

function validAction(input: DevelopmentWorkActionV1): boolean {
  const base = ['action', 'scope', 'admission', 'sourceMessageRevision'];
  const fields: Record<DevelopmentWorkActionV1['action'], readonly string[]> = {
    resolve: [],
    admit: ['title', 'why', 'closure', 'time', 'artifactRefs', 'parentTaskRef', 'predecessorTaskRef'],
    adopt: ['taskId', 'expectedSnapshot', 'closure', 'time', 'artifactRefs', 'parentTaskRef', 'predecessorTaskRef'],
    resume: ['taskId', 'expectedRevision', 'time'],
    bind: ['taskId', 'expectedRevision', 'time', 'parentTaskRef', 'predecessorTaskRef'],
  };
  if (Object.keys(input).some((key) => !base.includes(key) && !fields[input.action].includes(key))) return false;
  if (input.action === 'resolve') return true;
  if (input.action === 'admit') return !!input.title && !input.taskId;
  if (!input.taskId) return false;
  return input.action === 'adopt' ? !!input.expectedSnapshot : input.expectedRevision !== undefined;
}

async function ownedTarget(tasks: ITaskStore, actor: CallbackActor, taskId?: string): Promise<TaskItem | null> {
  if (!taskId) return null;
  const task = await tasks.get(taskId);
  return task?.userId === actor.userId && task.threadId === actor.threadId && task.ownerCatId === actor.catId
    ? task
    : null;
}

async function applyDevelopmentAction(
  deps: Dependencies,
  actor: CallbackActor,
  input: DevelopmentWorkActionV1,
  source: StoredMessage,
  scope: DevelopmentScopeV1,
  existing: TaskItem | null,
) {
  if (input.action === 'resolve') throw new Error('Resolve cannot mutate development work');
  const lifecycle = new EntrustedWorkLifecycleService(deps.taskStore);
  const prepared = lifecycle.prepareAdmission(
    {
      task: {
        threadId: actor.threadId,
        userId: actor.userId,
        createdBy: actor.catId,
        ownerCatId: actor.catId,
        title: input.title ?? existing?.title ?? 'Development work',
        why: input.why ?? existing?.why ?? '',
      },
      admission: {
        ...input.admission,
        intendedOutcome: input.admission.intendedOutcome ?? existing?.entrustedWork?.intendedOutcome,
      },
      closure:
        input.closure ??
        (existing?.entrustedWork
          ? {
              condition: existing.entrustedWork.closure.condition,
              expectedSignal: existing.entrustedWork.closure.expectedSignal,
            }
          : undefined),
      time: input.time,
      artifactRefs: input.artifactRefs,
    },
    admissionSourceContext(source),
  );
  if ('result' in prepared) return prepared;
  return deps.taskStore.transitionDevelopmentWork({
    action: input.action,
    actor,
    scope: scope,
    sourceRef: `message:${source.id}`,
    sourceRevision: input.sourceMessageRevision,
    idempotencyKey: input.admission.idempotencyKey,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    ...(input.expectedSnapshot ? { expectedSnapshot: input.expectedSnapshot } : {}),
    ...(input.parentTaskRef ? { parentTaskRef: input.parentTaskRef } : {}),
    ...(input.predecessorTaskRef ? { predecessorTaskRef: input.predecessorTaskRef } : {}),
    ...(input.time ? { time: input.time } : {}),
    title: prepared.task.title,
    why: prepared.task.why,
    ...(input.action === 'admit' || input.action === 'adopt' ? { contract: prepared.entrustedWork } : {}),
  });
}

export function registerCallbackDevelopmentWorkRoutes(app: FastifyInstance, deps: Dependencies): void {
  app.post('/api/callbacks/development-work', (request, reply) => handleDevelopmentWorkRequest(request, reply, deps));
}

async function handleDevelopmentWorkRequest(request: FastifyRequest, reply: FastifyReply, deps: Dependencies) {
  const record = requireCallbackAuth(request, reply);
  if (!record) return;
  const actor = deriveCallbackActor(record);
  const parsed = developmentWorkActionV1Schema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ error: 'Invalid development action' });
  if (!validAction(parsed.data))
    return reply.status(409).send({ error: 'Fields do not match this development action' });
  const input = parsed.data;
  const thread = await deps.threadStore?.get(actor.threadId);
  if (!thread || thread.createdBy !== actor.userId) return reply.status(403).send({ error: 'Thread access denied' });
  if (thread.deletedAt) return reply.status(410).send({ error: 'Thread is deleted' });
  try {
    // Scope lookup itself requires the same exact authorized source as admission.
    const source = await assertDirectAdmissionSourceCustody(deps.messageStore, actor, input.admission);
    if (!source || deriveGrowingSourceMessageRevision(source) !== input.sourceMessageRevision) {
      return reply.status(409).send({ error: 'Development requires a current source-local human authorization' });
    }
    const docs =
      deps.developmentDocuments ??
      new DevelopmentScopeGitDocuments(
        thread.projectPath === 'default' ? resolveActiveProjectRoot() : thread.projectPath,
      );
    const resolution = await new DevelopmentScopeResolver(deps.taskStore, docs).resolve(actor, input.scope);
    if (resolution.result !== 'resolved' || input.action === 'resolve') return resolution;
    const existing = await ownedTarget(deps.taskStore, actor, input.taskId);
    if (input.taskId && !existing) return reply.status(403).send({ result: 'forbidden' });
    if (
      existing?.entrustedWork &&
      input.admission.intendedOutcome &&
      input.admission.intendedOutcome !== existing.entrustedWork.intendedOutcome
    ) {
      return reply.status(409).send({
        error: 'Continuation preserves the accepted outcome; use a newly authorized scope for different work',
      });
    }
    const result = await applyDevelopmentAction(deps, actor, input, source, resolution.scope, existing);
    if ('task' in result && result.result !== 'resume_required') {
      deps.socketManager.emitToUser(actor.userId, 'entrusted_work_projection_invalidated', {
        ownerUserId: actor.userId,
      });
      deps.socketManager.broadcastToRoom(
        `thread:${actor.threadId}`,
        result.result === 'admitted' ? 'task_created' : 'task_updated',
        result.task,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof EntrustedWorkLifecycleError)
      return reply.status(409).send({ error: error.message, code: error.code });
    throw error;
  }
}
