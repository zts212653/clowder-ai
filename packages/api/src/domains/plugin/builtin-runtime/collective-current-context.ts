import { isDeepStrictEqual } from 'node:util';
import type { CollectiveConnector, CollectiveWorkAcceptanceInput } from '@cat-cafe/collective-connector';
import type { InvocationRecord } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { PreparedArtifactReader } from '../../growing/EntrustedWorkOwnerReadService.js';
import { collectiveContextError, opaqueRef, verifyRef } from './collective-context-refs.js';
import type { CollectiveInvocationSource } from './collective-participation-source.js';
import { resolveCollectiveParticipationSource } from './collective-participation-source.js';
import { readCollectivePreparedResultArtifact } from './collective-prepared-result.js';
import { assertReconsiderationInput, ownerWakeDecision } from './collective-work/collective-reconsideration-source.js';
import {
  CollectiveWorkArtifactReader,
  readPreviousCollectiveWorkArtifact,
} from './collective-work/collective-work-artifact-read.js';
import { publishCollectiveProgress } from './collective-work/collective-work-progress.js';
import {
  type CollectiveContinueWorkInput,
  continueWorkFromSource,
  currentWorkSourceContext,
} from './collective-work/collective-work-source-context.js';
import type { CollectiveWorkAuthority } from './collective-work-authority.js';

export { collectiveContextError } from './collective-context-refs.js';
export type { CollectiveInvocationSource } from './collective-participation-source.js';

interface CollectiveContextOptions {
  readonly workAuthority?: CollectiveWorkAuthority;
  readonly artifactReader?: PreparedArtifactReader;
  readonly artifactUploadDir?: string;
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
  private readonly artifactContentReader?: CollectiveWorkArtifactReader;
  constructor(private readonly options: CollectiveContextOptions) {
    if (options.artifactUploadDir)
      this.artifactContentReader = new CollectiveWorkArtifactReader(options.messageStore, options.artifactUploadDir);
  }

  async resolvePublic(input: CollectiveInvocationSource) {
    return resolveCollectiveParticipationSource(this.options, input, input.catId);
  }

  async current(auth: InvocationRecord) {
    const binding = await this.requireInvocationSource(auth);
    const connector = this.requireConnector();
    const workRevision = 'work' in binding ? binding.work.revision : undefined;
    const resultRevision = 'work' in binding ? binding.work.resultRevision : undefined;
    let operation = await connector.prepareReply(
      binding.source,
      binding.sourceRef,
      binding.resultKey,
      workRevision,
      resultRevision,
      'work' in binding
        ? { revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId }
        : undefined,
    );
    if (operation.status === 'queued' || operation.status === 'sending') {
      await connector.sync(binding.source.connectionId);
      operation = await connector.prepareReply(
        binding.source,
        binding.sourceRef,
        binding.resultKey,
        workRevision,
        resultRevision,
        'work' in binding
          ? { revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId }
          : undefined,
      );
    }
    return {
      kind: 'collective' as const,
      authority: binding.authority,
      ...(binding.authority === 'public_participation'
        ? {
            workDecision: await ownerWakeDecision(connector, binding),
            workSourceContext: await currentWorkSourceContext(connector, auth, binding),
          }
        : {}),
      ...('workRef' in binding
        ? { workRef: binding.workRef, progressOperationRef: opaqueRef(auth, 'progress', binding.refScope) }
        : {}),
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
    const connector = this.requireConnector();
    const context = await connector.readParticipationContext(binding.source, afterSequence, limit);
    const previousResultArtifact =
      'work' in binding
        ? await readPreviousCollectiveWorkArtifact(connector, binding, this.artifactContentReader, auth.catId)
        : undefined;
    const fresh = await this.requireInvocationSource(auth);
    if (fresh.refScope !== binding.refScope)
      throw collectiveContextError('WORK_EXECUTION_NOT_CURRENT', 'Current Work changed during context read');
    return { ...context, ...(previousResultArtifact ? { previousResultArtifact } : {}) };
  }

  async setInterest(auth: InvocationRecord, contextRef: string, state: 'listen' | 'withdraw') {
    const binding = await this.requireInvocationSource(auth);
    verifyRef(auth, contextRef, 'context', binding.refScope);
    const connector = this.requireConnector();
    const route = await connector.getHostRoute(binding.source.connectionId);
    if (!route) throw collectiveContextError('PARTICIPATION_REVOKED', 'Host participation route is unavailable');
    const updated = await connector.setStandingInterest(
      binding.source.connectionId,
      { catId: auth.catId, channelId: binding.source.location.channelId, state },
      route.attentionRevision ?? 0,
    );
    return {
      catId: auth.catId,
      channelId: binding.source.location.channelId,
      state,
      attentionRevision: updated.attentionRevision,
    };
  }

  async proposeWork(
    auth: InvocationRecord,
    contextRef: string,
    input: { readonly title?: string; readonly intendedOutcome?: string; readonly requestKind?: string },
  ) {
    const binding = await this.requireInvocationSource(auth);
    if (binding.authority !== 'public_participation') {
      throw collectiveContextError('WORK_AUTHORITY_REQUIRED', 'Private Work cannot create another public commitment');
    }
    verifyRef(auth, contextRef, 'context', binding.refScope);
    return this.requireConnector().proposeWork(
      binding.source,
      `work-proposal:${auth.invocationId}`,
      {
        catId: auth.catId,
        agentId: auth.catId,
        displayName: binding.displayName,
        sessionRef: auth.invocationId,
      },
      input,
    );
  }

  async acceptWork(auth: InvocationRecord, contextRef: string, input: CollectiveWorkAcceptanceInput) {
    const binding = await this.requireInvocationSource(auth);
    if (binding.authority !== 'public_participation')
      throw collectiveContextError(
        'WORK_AUTHORITY_REQUIRED',
        'An admitted private Work cannot create another commitment',
      );
    verifyRef(auth, contextRef, 'context', binding.refScope);
    assertReconsiderationInput(binding.ownerWakePurpose, input);
    const connector = this.requireConnector();
    const work = await connector.acceptWork(
      binding.source,
      {
        catId: auth.catId,
        agentId: auth.catId,
        displayName: binding.displayName,
        sessionRef: auth.invocationId,
      },
      input,
    );
    await connector.sync(binding.source.connectionId);
    return {
      workId: work.workId,
      assignmentEventId: work.assignmentEventId,
      accountableHumanId: work.accountableHumanId,
      acceptance: work.acceptance,
      lifecycle: work.lifecycle,
      disposition: 'accepted_pending_host_admission' as const,
    };
  }

  async continueWork(auth: InvocationRecord, contextRef: string, input: CollectiveContinueWorkInput) {
    const binding = await this.requireInvocationSource(auth);
    if (binding.authority !== 'public_participation')
      throw collectiveContextError(
        'WORK_AUTHORITY_REQUIRED',
        'Private execution cannot authorize another continuation',
      );
    verifyRef(auth, contextRef, 'context', binding.refScope);
    assertReconsiderationInput(binding.ownerWakePurpose, input);
    return continueWorkFromSource(this.requireConnector(), auth, binding, input);
  }

  async reply(auth: InvocationRecord, returnRef: string, replyOperationRef: string, body: string) {
    const binding = await this.requireInvocationSource(auth);
    const connector = this.requireConnector();
    const operation = await connector.prepareReply(
      binding.source,
      binding.sourceRef,
      binding.resultKey,
      'work' in binding ? binding.work.revision : undefined,
      'work' in binding ? binding.work.resultRevision : undefined,
      'work' in binding
        ? { revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId }
        : undefined,
    );
    verifyRef(auth, returnRef, 'return', binding.refScope);
    verifyRef(auth, replyOperationRef, `reply:${operation.outboxId}`, binding.refScope);
    const artifactSnapshot =
      'work' in binding
        ? await readCollectivePreparedResultArtifact(
            binding,
            auth,
            this.options.artifactReader,
            this.artifactContentReader,
          )
        : undefined;
    const fresh = await this.requireInvocationSource(auth);
    if (fresh.refScope !== binding.refScope)
      throw collectiveContextError('WORK_EXECUTION_NOT_CURRENT', 'Current Work changed during result preparation');
    await connector.submitReply(
      binding.source,
      binding.sourceRef,
      binding.resultKey,
      operation.outboxId,
      body,
      {
        catId: auth.catId,
        agentId: auth.catId,
        displayName: binding.displayName,
        sessionRef: auth.invocationId,
      },
      artifactSnapshot,
      'work' in binding ? binding.work.resultRevision : undefined,
      'work' in binding
        ? { revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId }
        : undefined,
    );
    await connector.sync(binding.source.connectionId);
    return this.current(auth);
  }

  async progress(auth: InvocationRecord, returnRef: string, progressOperationRef: string, body: string) {
    const binding = await this.requireInvocationSource(auth);
    if (!('work' in binding))
      throw collectiveContextError('WORK_AUTHORITY_REQUIRED', 'Progress requires an admitted private Work');
    verifyRef(auth, returnRef, 'return', binding.refScope);
    verifyRef(auth, progressOperationRef, 'progress', binding.refScope);
    return publishCollectiveProgress(this.requireConnector(), auth, binding, body);
  }

  private async requireInvocationSource(auth: InvocationRecord) {
    if (auth.collectiveWorkBinding) {
      const binding = await this.resolvePrivate(auth, 'callback');
      if (!binding) throw collectiveContextError('OWNER_ADMISSION_UNAVAILABLE', 'Current Task binding changed');
      return {
        ...binding,
        resultKey: binding.work.resultKey,
        refScope: `${binding.sourceRef}:work:${binding.work.task.id}:${binding.work.revision}:result:${binding.work.resultRevision}:execution:${binding.work.executionRevision}:${binding.work.executionRef ?? binding.work.authorityRef}`,
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
    input: Pick<InvocationRecord, 'userId' | 'threadId' | 'catId' | 'ownerAuthProvenance' | 'originTriggerMessageId'> &
      Pick<Partial<InvocationRecord>, 'collectiveWorkBinding'>,
    phase: 'admission' | 'callback',
  ) {
    const authority = this.options.workAuthority;
    if (!authority) return undefined;
    const work = await authority.resolve(input, phase);
    if (!work) return undefined;
    const expected = input.collectiveWorkBinding;
    if (
      expected &&
      (work.task.id !== expected.taskId ||
        work.sourceRef !== expected.sourceRef ||
        work.authorityRef !== expected.authorityRef ||
        work.revision < expected.observedRevision ||
        work.resultRevision !== expected.resultRevision ||
        work.executionRevision !== (expected.executionRevision ?? 1) ||
        work.executionRef !== expected.executionRef)
    )
      throw collectiveContextError('WORK_EXECUTION_NOT_CURRENT', 'Current invocation binding changed');
    const thread = await this.options.threadStore.get(input.threadId);
    if (thread?.createdBy !== input.userId || thread.deletedAt)
      throw collectiveContextError('OWNER_ADMISSION_UNAVAILABLE', 'Private Task Thread is unavailable');
    const message = await authority.sourceForTask(work.task, work.sourceRef);
    const source = await resolveCollectiveParticipationSource(
      this.options,
      {
        ...input,
        threadId: message.threadId,
        originTriggerMessageId: message.id,
      },
      work.ownerCatId,
      input.catId,
    );
    if (!source || source.sourceRef !== work.sourceRef)
      throw collectiveContextError('RETURN_UNAVAILABLE', 'Task source cannot be resolved');
    return {
      ...source,
      work,
    };
  }

  private requireConnector() {
    const connector = this.options.connector();
    if (!connector) throw collectiveContextError('RETURN_UNAVAILABLE', 'Collective Connector is unavailable');
    return connector;
  }
}
