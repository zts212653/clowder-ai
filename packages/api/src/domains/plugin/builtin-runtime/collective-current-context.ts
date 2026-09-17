import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import { type CollectiveExecutionGrant, collectiveSourceIdentitySchema } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { CollectiveWorkAuthority } from './collective-work-authority.js';

export interface CollectiveInvocationSource {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly originTriggerMessageId?: string;
}

interface CollectiveContextOptions {
  readonly workAuthority?: CollectiveWorkAuthority;
  readonly connector: () => CollectiveConnector | undefined;
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly threadStore: {
    get(
      id: string,
    ):
      | { createdBy: string; deletedAt?: number | null }
      | null
      | Promise<{ createdBy: string; deletedAt?: number | null } | null>;
  };
}

/** Resolves from authenticated invocation → durable Message → current Host/Service authority. */
export class CollectiveCurrentContext {
  constructor(private readonly options: CollectiveContextOptions) {}

  async resolvePublic(input: CollectiveInvocationSource) {
    if (!input.originTriggerMessageId) return undefined;
    const message = await this.options.messageStore.getById(input.originTriggerMessageId);
    if (message?.source?.connector !== 'collective') return undefined;
    if (
      message.userId !== input.userId ||
      message.threadId !== input.threadId ||
      message.deletedAt ||
      message.recall ||
      message._tombstone ||
      message.catId !== null
    ) {
      throw collectiveContextError('RETURN_UNAVAILABLE', 'Collective source Message is unavailable');
    }
    const parsed = collectiveSourceIdentitySchema.safeParse(message.source.meta?.participation);
    if (!parsed.success || parsed.data.catId !== input.catId)
      throw collectiveContextError('RETURN_UNAVAILABLE', 'Source has no exact participant identity');
    const source = parsed.data;
    const connector = this.requireConnector();
    const context = await connector.readParticipationContext(source);
    const route = await connector.getHostRoute(source.connectionId);
    const connection = await connector.getProjection(source.connectionId);
    const binding = route?.agentRoutes[`${connection.authorizedHumanId}:${input.catId}`];
    const thread = await this.options.threadStore.get(message.threadId);
    if (
      route?.localOwnerUserId !== input.userId ||
      route.revision !== source.participationRevision ||
      binding?.threadId !== message.threadId ||
      thread?.createdBy !== input.userId ||
      thread.deletedAt ||
      !binding.participation
    )
      throw collectiveContextError('PARTICIPATION_REVOKED', 'Host participation binding changed');
    const grant: CollectiveExecutionGrant = {
      kind: 'collective-participation',
      originTriggerMessageId: message.id,
      source,
    };
    return {
      grant,
      sourceRef: `message:${message.id}`,
      source,
      context,
      displayName: binding.participation.displayName,
    };
  }

  async current(auth: InvocationRecord) {
    const binding = await this.requireInvocationSource(auth);
    const connector = this.requireConnector();
    const workRevision = 'work' in binding ? binding.work.revision : undefined;
    let operation = await connector.prepareReply(binding.source, binding.sourceRef, binding.resultKey, workRevision);
    if (operation.status === 'queued' || operation.status === 'sending') {
      await connector.sync(binding.source.connectionId);
      operation = await connector.prepareReply(binding.source, binding.sourceRef, binding.resultKey, workRevision);
    }
    return {
      kind: 'collective' as const,
      authority: binding.authority,
      ...('workRef' in binding ? { workRef: binding.workRef } : {}),
      actor: binding.source.actor,
      location: binding.source.location,
      participant: binding.displayName,
      request: binding.context.source,
      contextRef: opaqueRef(auth, 'context', binding.refScope),
      returnRef: opaqueRef(auth, 'return', binding.refScope),
      replyOperationRef: opaqueRef(auth, `reply:${operation.outboxId}`, binding.refScope),
      reply: {
        status: operation.status,
        ...(operation.status !== 'prepared' ? { body: operation.body, author: operation.agent } : {}),
        ...(operation.acceptedEventId ? { eventId: operation.acceptedEventId } : {}),
        ...(operation.failureCode ? { code: operation.failureCode } : {}),
      },
    };
  }

  async read(auth: InvocationRecord, contextRef: string, afterSequence = 0, limit = 30) {
    const binding = await this.requireInvocationSource(auth);
    verifyRef(auth, contextRef, 'context', binding.refScope);
    return this.requireConnector().readParticipationContext(binding.source, afterSequence, limit);
  }

  async reply(auth: InvocationRecord, returnRef: string, replyOperationRef: string, body: string) {
    const binding = await this.requireInvocationSource(auth);
    const connector = this.requireConnector();
    const operation = await connector.prepareReply(
      binding.source,
      binding.sourceRef,
      binding.resultKey,
      'work' in binding ? binding.work.revision : undefined,
    );
    verifyRef(auth, returnRef, 'return', binding.refScope);
    verifyRef(auth, replyOperationRef, `reply:${operation.outboxId}`, binding.refScope);
    await connector.submitReply(binding.source, binding.sourceRef, binding.resultKey, operation.outboxId, body, {
      catId: auth.catId,
      agentId: auth.catId,
      displayName: binding.displayName,
      sessionRef: auth.invocationId,
    });
    await connector.sync(binding.source.connectionId);
    return this.current(auth);
  }

  private async requireInvocationSource(auth: InvocationRecord) {
    if (auth.collectiveWorkBinding) {
      const binding = await this.resolvePrivate(auth, 'callback');
      const expected = auth.collectiveWorkBinding;
      if (
        !binding ||
        binding.work.task.id !== expected.taskId ||
        binding.sourceRef !== expected.sourceRef ||
        binding.work.authorityRef !== expected.authorityRef ||
        binding.work.revision < expected.observedRevision
      )
        throw collectiveContextError('OWNER_ADMISSION_UNAVAILABLE', 'Current Task binding changed');
      return {
        ...binding,
        resultKey: binding.work.resultKey,
        refScope: `${binding.sourceRef}:work:${binding.work.task.id}:${binding.work.revision}`,
        workRef: { subjectRef: `task:work:${binding.work.task.id}`, revision: binding.work.revision },
        authority: 'owner_admitted_work' as const,
      };
    }
    if (
      !auth.executionGrant ||
      auth.ownerAuthProvenance !== 'unknown' ||
      auth.toolExecutionPolicy?.mode !== 'collective_participation'
    ) {
      throw collectiveContextError(
        'NOT_COLLECTIVE_ORIGIN',
        'Invocation has no direct Collective origin or admitted Task source',
      );
    }
    const binding = await this.resolvePublic(auth);
    if (!binding || !isDeepStrictEqual(binding.grant, auth.executionGrant))
      throw collectiveContextError('RETURN_UNAVAILABLE', 'Invocation source changed');
    return {
      ...binding,
      resultKey: 'request',
      refScope: binding.sourceRef,
      authority: 'public_participation' as const,
    };
  }

  async resolvePrivate(
    input: Pick<InvocationRecord, 'userId' | 'threadId' | 'catId' | 'ownerAuthProvenance' | 'originTriggerMessageId'>,
    phase: 'admission' | 'callback',
  ) {
    const work = await this.options.workAuthority?.resolve(input, phase);
    if (!work) return undefined;
    const thread = await this.options.threadStore.get(input.threadId);
    if (thread?.createdBy !== input.userId || thread.deletedAt)
      throw collectiveContextError('OWNER_ADMISSION_UNAVAILABLE', 'Private Task Thread is unavailable');
    const message = await this.options.workAuthority!.sourceForTask(work.task);
    const source = await this.resolvePublic({
      ...input,
      threadId: message.threadId,
      originTriggerMessageId: message.id,
    });
    if (!source || source.sourceRef !== work.sourceRef)
      throw collectiveContextError('RETURN_UNAVAILABLE', 'Task source cannot be resolved');
    return { ...source, work };
  }

  private requireConnector() {
    const connector = this.options.connector();
    if (!connector) throw collectiveContextError('RETURN_UNAVAILABLE', 'Collective Connector is unavailable');
    return connector;
  }
}

function opaqueRef(auth: InvocationRecord, operation: string, sourceRef: string): string {
  return createHmac('sha256', auth.callbackToken)
    .update(JSON.stringify([auth.invocationId, operation, sourceRef]))
    .digest('base64url');
}

function verifyRef(auth: InvocationRecord, actual: string, operation: string, sourceRef: string) {
  const expected = Buffer.from(opaqueRef(auth, operation, sourceRef));
  const received = Buffer.from(actual);
  if (received.length !== expected.length || !timingSafeEqual(expected, received)) {
    throw collectiveContextError(
      'RETURN_REF_INVALID',
      'This reference does not belong to the current invocation and source',
    );
  }
}

export function collectiveContextError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
