import { isDeepStrictEqual } from 'node:util';
import {
  type CatId,
  type CustodyAuthorityProvenanceV1,
  collectiveOwnerAdmissionV1Schema,
  collectiveSourceIdentitySchema,
  collectiveWorkInvocationV1Schema,
  type RegisteredCustodyGrantV1,
  type TaskItem,
} from '@cat-cafe/shared';
import type { InvocationRecord } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import {
  type EntrustedWorkAdmissionCommandV1,
  EntrustedWorkLifecycleService,
} from '../../growing/EntrustedWorkLifecycleService.js';

export interface CollectiveWorkAuthorityOptions {
  readonly messageStore: Pick<IMessageStore, 'getById' | 'appendIdempotent'>;
  readonly taskStore: ITaskStore;
  readonly standingGrant?: (
    source: StoredMessage,
    catId: string,
  ) => Promise<{ grant: RegisteredCustodyGrantV1; threadId: string } | undefined>;
}

/** Host authorizes private execution; Task remains the sole Work lifecycle owner. */
export class CollectiveWorkAuthority {
  constructor(private readonly options: CollectiveWorkAuthorityOptions) {}

  async admit(input: {
    ownerUserId: string;
    source: StoredMessage;
    catId: CatId;
    threadId: string;
    ownerAuthProvenance: 'strict';
    standingGrant?: CustodyAuthorityProvenanceV1;
    requestId: string;
    title: string;
    intendedOutcome: string;
    closure: NonNullable<EntrustedWorkAdmissionCommandV1['closure']>;
    time?: EntrustedWorkAdmissionCommandV1['time'];
  }) {
    const sourceRef = `message:${input.source.id}`;
    const currentSource = await this.options.messageStore.getById(input.source.id);
    const identity = collectiveSourceIdentitySchema.safeParse(currentSource?.source?.meta?.participation);
    if (
      input.ownerAuthProvenance !== 'strict' ||
      !currentSource ||
      currentSource.deletedAt ||
      currentSource.recall ||
      currentSource._tombstone ||
      currentSource.userId !== input.ownerUserId ||
      !identity.success ||
      identity.data.catId !== input.catId
    )
      throw workError('OWNER_ADMISSION_UNAVAILABLE', 'Owner admission must cover an exact current Collective source');
    if (input.standingGrant)
      await this.validateStandingGrant(currentSource, input.catId, input.threadId, input.standingGrant);
    const receipt = collectiveOwnerAdmissionV1Schema.parse({
      v: 1,
      sourceRef,
      catId: input.catId,
      ownerAuthProvenance: 'strict',
      ...(input.standingGrant ? { standingGrant: input.standingGrant } : {}),
    });
    const ownerMessage = await this.options.messageStore.appendIdempotent({
      userId: input.ownerUserId,
      threadId: input.threadId,
      catId: null,
      mentions: [],
      timestamp: Date.now(),
      content: input.intendedOutcome,
      extra: { collectiveOwnerAdmissionV1: receipt },
      idempotencyKey: `collective-owner-admission:${input.source.id}:${input.catId}`,
    });
    if (
      ownerMessage.message.content !== input.intendedOutcome ||
      !isDeepStrictEqual(ownerMessage.message.extra?.collectiveOwnerAdmissionV1, receipt)
    )
      throw workError('OWNER_ADMISSION_CONFLICT', 'Owner admission request already contains different work');
    const grant = ownerReceiptGrant(ownerMessage.message);
    const authorityProvenance = {
      grantRef: grant.grantRef,
      grantRevision: grant.revision,
      producerRef: grant.producerRef,
      grantOwnerRef: grant.grantOwnerRef,
      grantOwnerRevision: grant.grantOwnerRevision,
      sourceRef,
      sourceRevision: input.source.id,
      matchedScope: sourceRef,
      admissionAuthority: grant.admissionAuthority,
      idempotencySource: grant.idempotencySource,
    };
    const lifecycle = new EntrustedWorkLifecycleService(this.options.taskStore, {
      custodyGrantRegistry: { [grant.grantRef]: grant },
    });
    return lifecycle.admitOrResume(
      {
        task: {
          threadId: input.threadId,
          title: input.title,
          why: input.intendedOutcome.slice(0, 1000),
          createdBy: 'user',
          ownerCatId: input.catId,
          userId: input.ownerUserId,
        },
        admission: {
          basis: 'authorized_source',
          sourceRefs: [sourceRef],
          intendedOutcome: input.intendedOutcome,
          idempotencyKey: `collective-work:${input.source.id}:${input.catId}`,
          authorityProvenance,
        },
        closure: input.closure,
        ...(input.time ? { time: input.time } : {}),
      },
      { sourceRef, content: currentSource.content },
    );
  }

  async admitStanding(source: StoredMessage, catId: CatId) {
    if (source.source?.meta?.workRequest !== 'entrust') return undefined;
    const current = await this.options.standingGrant?.(source, catId);
    if (!current) return undefined;
    const { grant } = current;
    const sourceRef = `message:${source.id}`;
    return this.admit({
      ownerUserId: source.userId,
      ownerAuthProvenance: 'strict',
      source,
      catId,
      threadId: current.threadId,
      requestId: `standing:${source.id}`,
      title: source.content.slice(0, 160),
      intendedOutcome: source.content,
      closure: {
        condition: 'A reviewable result answers the entrusted request at its original Collective location',
        expectedSignal: 'collective:accepted-result',
      },
      standingGrant: {
        grantRef: grant.grantRef,
        grantRevision: grant.revision,
        producerRef: grant.producerRef,
        grantOwnerRef: grant.grantOwnerRef,
        grantOwnerRevision: grant.grantOwnerRevision,
        sourceRef,
        sourceRevision: source.id,
        matchedScope: sourceRef,
        admissionAuthority: grant.admissionAuthority,
        idempotencySource: grant.idempotencySource,
      },
    });
  }

  async resolve(
    input: Pick<InvocationRecord, 'userId' | 'threadId' | 'catId' | 'ownerAuthProvenance' | 'originTriggerMessageId'>,
    phase: 'admission' | 'callback',
  ) {
    const trigger = input.originTriggerMessageId
      ? await this.options.messageStore.getById(input.originTriggerMessageId)
      : null;
    const raw = trigger?.extra?.collectiveWorkInvocationV1;
    if (raw === undefined && !trigger?.extra?.collectiveAuthorizationInvalid) return undefined;
    const pointer = collectiveWorkInvocationV1Schema.safeParse(raw);
    if (
      !pointer.success ||
      !trigger ||
      trigger.extra?.collectiveAuthorizationInvalid ||
      trigger.recall ||
      trigger.deletedAt ||
      trigger._tombstone ||
      trigger.userId !== input.userId ||
      trigger.threadId !== input.threadId ||
      trigger.catId !== null ||
      trigger.source ||
      input.ownerAuthProvenance !== 'strict'
    ) {
      throw workError('OWNER_ADMISSION_UNAVAILABLE', 'Private Work has no authenticated owner execution trigger');
    }
    const task = await this.options.taskStore.get(pointer.data.taskId);
    const contract = task?.entrustedWork;
    if (
      !task ||
      task.kind !== 'work' ||
      !contract ||
      task.userId !== input.userId ||
      task.threadId !== input.threadId ||
      task.ownerCatId !== input.catId ||
      contract.admission.sourceRefs.length !== 1 ||
      !contract.admission.sourceRefs[0]?.startsWith('message:') ||
      contract.admission.basis !== 'authorized_source' ||
      !contract.admission.authorityRef ||
      (phase === 'admission' && contract.revision !== pointer.data.observedRevision) ||
      contract.revision < pointer.data.observedRevision ||
      task.status === 'done' ||
      contract.closure.state !== 'open'
    )
      throw workError('OWNER_ADMISSION_UNAVAILABLE', 'Current Task does not authorize this private execution');
    const sourceRef = contract.admission.sourceRefs[0];
    const authorityRef = contract.admission.authorityRef;
    if (!authorityRef.startsWith('message:'))
      throw workError('OWNER_ADMISSION_UNAVAILABLE', 'Task has no resolvable Host owner admission');
    const ownerMessage = await this.options.messageStore.getById(authorityRef.slice('message:'.length));
    const receipt = collectiveOwnerAdmissionV1Schema.safeParse(ownerMessage?.extra?.collectiveOwnerAdmissionV1);
    if (
      !receipt.success ||
      !ownerMessage ||
      ownerMessage.extra?.collectiveAuthorizationInvalid ||
      ownerMessage.recall ||
      ownerMessage.deletedAt ||
      ownerMessage._tombstone ||
      ownerMessage.source ||
      ownerMessage.catId !== null ||
      ownerMessage.userId !== input.userId ||
      ownerMessage.threadId !== task.threadId ||
      receipt.data.catId !== input.catId ||
      receipt.data.sourceRef !== sourceRef
    )
      throw workError('OWNER_ADMISSION_UNAVAILABLE', 'Owner admission was removed or no longer covers this Task');
    if (receipt.data.standingGrant) {
      await this.validateStandingGrant(
        await this.sourceForTask(task),
        input.catId,
        input.threadId,
        receipt.data.standingGrant,
      );
    }
    return { task, sourceRef, authorityRef, revision: contract.revision, resultKey: `work:${task.id}` };
  }

  async sourceForTask(task: TaskItem) {
    const refs = task.entrustedWork?.admission.sourceRefs;
    if (refs?.length !== 1 || !refs[0]?.startsWith('message:'))
      throw workError('RETURN_UNAVAILABLE', 'Work has no unique result source');
    const source = await this.options.messageStore.getById(refs[0].slice('message:'.length));
    if (!source || source.deletedAt || source.recall || source._tombstone)
      throw workError('RETURN_UNAVAILABLE', 'Work source is unavailable');
    return source;
  }

  private async validateStandingGrant(
    source: StoredMessage,
    catId: string,
    threadId: string,
    provenance: CustodyAuthorityProvenanceV1,
  ) {
    const current = await this.options.standingGrant?.(source, catId);
    if (!current || current.threadId !== threadId || provenance.sourceRevision !== source.id)
      throw workError('OWNER_ADMISSION_UNAVAILABLE', 'Standing owner admission is no longer current');
    const lifecycle = new EntrustedWorkLifecycleService(this.options.taskStore, {
      custodyGrantRegistry: { [current.grant.grantRef]: current.grant },
    });
    lifecycle.assertCurrentAuthorization({
      basis: 'authorized_source',
      sourceRefs: [`message:${source.id}`],
      idempotencyKey: `standing:${source.id}`,
      authorityProvenance: provenance,
    });
  }
}

function ownerReceiptGrant(message: StoredMessage): RegisteredCustodyGrantV1 {
  const receipt = collectiveOwnerAdmissionV1Schema.parse(message.extra?.collectiveOwnerAdmissionV1);
  return {
    grantRef: `message:${message.id}`,
    revision: 1,
    producerRef: 'host:collective-owner-admission',
    grantOwnerRef: `user:${message.userId}`,
    grantOwnerRevision: message.id,
    allowedSourceScope: [receipt.sourceRef],
    admissionAuthority: 'task_admit_or_resume',
    validity: { state: 'current', expiresAt: null },
    idempotencySource: 'source_ref_and_revision',
  };
}

function workError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
