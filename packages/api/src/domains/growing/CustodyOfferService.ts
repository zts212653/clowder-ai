import {
  type CatId,
  type CustodyAdmissionResultV1,
  type CustodyOfferV1,
  custodyAdmissionResultV1Schema,
  custodyOfferV1Schema,
  type EntrustedWorkClosureSpecV1,
  type EntrustedWorkV1,
} from '@cat-cafe/shared';
import {
  type CustodyOfferTransitionResult,
  deriveGrowingSourceMessageRevision,
  type IMessageStore,
} from '../cats/services/stores/ports/MessageStore.js';

export interface AcceptedCustodyAdmissionCommand {
  sourceMessageId: string;
  sourceMessageRevision: string;
  offerId: string;
  actorRef: string;
  dispositionAt: number;
  idempotencyKey: string;
  taskDraft?: AcceptedCustodyTaskDraft;
}

export interface AcceptedCustodyTaskDraft {
  title: string;
  why: string;
  intendedOutcome: string;
  closure: EntrustedWorkClosureSpecV1;
  time?: EntrustedWorkV1['time'];
  artifactRefs?: string[];
  ownerCatId?: CatId;
}

export interface AcceptedCustodyAdmissionPort {
  admitOrResumeAcceptedOffer(command: AcceptedCustodyAdmissionCommand): Promise<CustodyAdmissionResultV1>;
}

export interface RecordPendingOfferInput {
  sourceMessageId: string;
  sourceMessageRevision: string;
  offerId: string;
  policyVersion: string;
  reasonCode: string;
}

export interface AcceptOfferInput {
  sourceMessageId: string;
  sourceMessageRevision: string;
  offerId: string;
  actorRef: string;
  dispositionAt: number;
  idempotencyKey: string;
}

export interface RefuseOfferInput {
  sourceMessageId: string;
  sourceMessageRevision: string;
  offerId: string;
  disposition: 'declined' | 'dismissed';
  actorRef: string;
  dispositionAt: number;
}

export interface RetryAcceptedAdmissionInput {
  sourceMessageId: string;
  sourceMessageRevision: string;
  offerId: string;
  taskDraft: AcceptedCustodyTaskDraft;
}

type ReadFailure = { kind: 'not_found' } | { kind: 'invalid_source' } | { kind: 'stale_source' };

export type CustodyOfferReadResult =
  | {
      kind: 'found';
      sourceMessageRevision: string;
      offer: CustodyOfferV1 | null;
    }
  | Exclude<ReadFailure, { kind: 'stale_source' }>;

export type RecordPendingOfferResult =
  | { kind: 'recorded' | 'replay'; offer: CustodyOfferV1 }
  | { kind: 'conflict'; offer: CustodyOfferV1 | null }
  | ReadFailure;

export type CustodyOfferDecisionResult =
  | {
      kind: 'accepted' | 'declined' | 'dismissed';
      transitioned: boolean;
      offer: CustodyOfferV1;
    }
  | { kind: 'conflict'; offer: CustodyOfferV1 | null }
  | ReadFailure;

type AcceptedOffer = Extract<CustodyOfferV1, { disposition: 'accepted' }>;

type AcceptedDispositionResolution =
  | { ready: true; offer: AcceptedOffer; transitioned: boolean }
  | { ready: false; result: CustodyOfferDecisionResult };

function transitionFailure(
  result: Exclude<CustodyOfferTransitionResult, { kind: 'updated' }>,
): { kind: 'conflict'; offer: CustodyOfferV1 | null } | ReadFailure {
  switch (result.kind) {
    case 'not_found':
      return { kind: 'not_found' };
    case 'source_revision_mismatch':
      return { kind: 'stale_source' };
    case 'state_conflict':
      return { kind: 'conflict', offer: result.currentOffer };
    case 'invalid_state':
    case 'invalid_transition':
      return { kind: 'invalid_source' };
  }
}

export class CustodyOfferService {
  constructor(
    private readonly messages: IMessageStore,
    private readonly admission?: AcceptedCustodyAdmissionPort,
  ) {}

  async readOffer(sourceMessageId: string): Promise<CustodyOfferReadResult> {
    const message = await this.messages.getById(sourceMessageId);
    if (!message) return { kind: 'not_found' };
    if (message.recall || message._tombstone || message.custodyOfferParseFailure) {
      return { kind: 'invalid_source' };
    }
    const sourceMessageRevision = deriveGrowingSourceMessageRevision(message);
    const rawOffer = message.extra?.custodyOfferV1;
    if (rawOffer === undefined) return { kind: 'found', sourceMessageRevision, offer: null };
    const parsed = custodyOfferV1Schema.safeParse(rawOffer);
    if (!parsed.success || parsed.data.sourceMessageRevision !== sourceMessageRevision) {
      return { kind: 'invalid_source' };
    }
    return { kind: 'found', sourceMessageRevision, offer: parsed.data };
  }

  async recordPendingOffer(input: RecordPendingOfferInput): Promise<RecordPendingOfferResult> {
    const read = await this.readOffer(input.sourceMessageId);
    if (read.kind !== 'found') return read;
    if (read.sourceMessageRevision !== input.sourceMessageRevision) return { kind: 'stale_source' };
    if (read.offer) {
      return read.offer.offerId === input.offerId
        ? { kind: 'replay', offer: read.offer }
        : { kind: 'conflict', offer: read.offer };
    }
    const nextOffer: CustodyOfferV1 = {
      offerId: input.offerId,
      sourceMessageRevision: input.sourceMessageRevision,
      policyVersion: input.policyVersion,
      reasonCode: input.reasonCode,
      disposition: 'pending',
    };
    const transitioned = await this.messages.compareAndTransitionCustodyOffer(input.sourceMessageId, {
      expectedSourceMessageRevision: input.sourceMessageRevision,
      expectedOffer: null,
      nextOffer,
    });
    if (transitioned.kind === 'updated') return { kind: 'recorded', offer: nextOffer };
    if (transitioned.kind === 'state_conflict') {
      return transitioned.currentOffer?.offerId === input.offerId
        ? { kind: 'replay', offer: transitioned.currentOffer }
        : { kind: 'conflict', offer: transitioned.currentOffer };
    }
    return transitionFailure(transitioned);
  }

  async acceptOffer(input: AcceptOfferInput): Promise<CustodyOfferDecisionResult> {
    const read = await this.readOffer(input.sourceMessageId);
    if (read.kind !== 'found') return read;
    if (read.sourceMessageRevision !== input.sourceMessageRevision) return { kind: 'stale_source' };
    if (!read.offer || read.offer.offerId !== input.offerId) {
      return { kind: 'conflict', offer: read.offer };
    }
    if (read.offer.disposition === 'declined' || read.offer.disposition === 'dismissed') {
      return { kind: 'conflict', offer: read.offer };
    }
    const resolution = await this.acquireAcceptedDisposition(input, read.offer);
    if (!resolution.ready) return resolution.result;
    return this.finishAcceptedAdmission(input, resolution.offer, resolution.transitioned);
  }

  async retryAcceptedAdmission(input: RetryAcceptedAdmissionInput): Promise<CustodyOfferDecisionResult> {
    const read = await this.readOffer(input.sourceMessageId);
    if (read.kind !== 'found') return read;
    if (read.sourceMessageRevision !== input.sourceMessageRevision) return { kind: 'stale_source' };
    const accepted = read.offer;
    if (
      !accepted ||
      accepted.offerId !== input.offerId ||
      accepted.disposition !== 'accepted' ||
      accepted.admission.state !== 'resulted' ||
      accepted.admission.result.result !== 'needs_clarification'
    ) {
      return { kind: 'conflict', offer: accepted };
    }
    if (!this.admission) return { kind: 'accepted', transitioned: false, offer: accepted };

    const admissionResult = custodyAdmissionResultV1Schema.parse(
      await this.admission.admitOrResumeAcceptedOffer({
        sourceMessageId: input.sourceMessageId,
        sourceMessageRevision: input.sourceMessageRevision,
        offerId: input.offerId,
        actorRef: accepted.actorRef,
        dispositionAt: accepted.dispositionAt,
        idempotencyKey: accepted.admission.idempotencyKey,
        taskDraft: input.taskDraft,
      }),
    );
    if (admissionResult.result === 'needs_clarification') {
      return { kind: 'accepted', transitioned: false, offer: accepted };
    }
    const resulted: AcceptedOffer = {
      ...accepted,
      admission: {
        state: 'resulted',
        idempotencyKey: accepted.admission.idempotencyKey,
        result: admissionResult,
      },
    };
    const transition = await this.messages.compareAndTransitionCustodyOffer(input.sourceMessageId, {
      expectedSourceMessageRevision: input.sourceMessageRevision,
      expectedOffer: accepted,
      nextOffer: resulted,
    });
    if (transition.kind === 'updated') {
      return { kind: 'accepted', transitioned: true, offer: resulted };
    }
    if (transition.kind === 'state_conflict') {
      const current = transition.currentOffer;
      if (
        current?.offerId === input.offerId &&
        current.disposition === 'accepted' &&
        current.admission.state === 'resulted' &&
        current.admission.idempotencyKey === accepted.admission.idempotencyKey &&
        current.admission.result.result !== 'needs_clarification'
      ) {
        return { kind: 'accepted', transitioned: false, offer: current };
      }
    }
    return transitionFailure(transition);
  }

  private async acquireAcceptedDisposition(
    input: AcceptOfferInput,
    current: CustodyOfferV1,
  ): Promise<AcceptedDispositionResolution> {
    if (current.disposition === 'accepted') {
      return { ready: true, offer: current, transitioned: false };
    }
    if (current.disposition !== 'pending') {
      return { ready: false, result: { kind: 'invalid_source' } };
    }
    const accepted: AcceptedOffer = {
      ...current,
      disposition: 'accepted',
      actorRef: input.actorRef,
      dispositionAt: input.dispositionAt,
      admission: { state: 'pending', idempotencyKey: input.idempotencyKey },
    };
    const transition = await this.messages.compareAndTransitionCustodyOffer(input.sourceMessageId, {
      expectedSourceMessageRevision: input.sourceMessageRevision,
      expectedOffer: current,
      nextOffer: accepted,
    });
    if (transition.kind === 'updated') {
      return { ready: true, offer: accepted, transitioned: true };
    }
    if (transition.kind !== 'state_conflict') {
      return { ready: false, result: transitionFailure(transition) };
    }
    const concurrent = transition.currentOffer;
    if (!concurrent || concurrent.offerId !== input.offerId || concurrent.disposition !== 'accepted') {
      return { ready: false, result: { kind: 'conflict', offer: concurrent } };
    }
    return { ready: true, offer: concurrent, transitioned: false };
  }

  private async finishAcceptedAdmission(
    input: AcceptOfferInput,
    accepted: AcceptedOffer,
    transitionedDisposition: boolean,
  ): Promise<CustodyOfferDecisionResult> {
    if (accepted.admission.idempotencyKey !== input.idempotencyKey) {
      return { kind: 'conflict', offer: accepted };
    }
    if (accepted.admission.state === 'resulted' || !this.admission) {
      return { kind: 'accepted', transitioned: transitionedDisposition, offer: accepted };
    }

    const admissionResult = custodyAdmissionResultV1Schema.parse(
      await this.admission.admitOrResumeAcceptedOffer({
        sourceMessageId: input.sourceMessageId,
        sourceMessageRevision: input.sourceMessageRevision,
        offerId: input.offerId,
        actorRef: accepted.actorRef,
        dispositionAt: accepted.dispositionAt,
        idempotencyKey: accepted.admission.idempotencyKey,
      }),
    );
    const resulted: CustodyOfferV1 = {
      ...accepted,
      admission: {
        state: 'resulted',
        idempotencyKey: accepted.admission.idempotencyKey,
        result: admissionResult,
      },
    };
    const admissionTransition = await this.messages.compareAndTransitionCustodyOffer(input.sourceMessageId, {
      expectedSourceMessageRevision: input.sourceMessageRevision,
      expectedOffer: accepted,
      nextOffer: resulted,
    });
    if (admissionTransition.kind === 'updated') {
      return { kind: 'accepted', transitioned: true, offer: resulted };
    }
    if (admissionTransition.kind === 'state_conflict') {
      const current = admissionTransition.currentOffer;
      if (
        current?.disposition === 'accepted' &&
        current.offerId === input.offerId &&
        current.admission.state === 'resulted' &&
        current.admission.idempotencyKey === input.idempotencyKey
      ) {
        return { kind: 'accepted', transitioned: transitionedDisposition, offer: current };
      }
      return { kind: 'conflict', offer: current };
    }
    return transitionFailure(admissionTransition);
  }

  async refuseOffer(input: RefuseOfferInput): Promise<CustodyOfferDecisionResult> {
    const read = await this.readOffer(input.sourceMessageId);
    if (read.kind !== 'found') return read;
    if (read.sourceMessageRevision !== input.sourceMessageRevision) return { kind: 'stale_source' };
    if (!read.offer || read.offer.offerId !== input.offerId) {
      return { kind: 'conflict', offer: read.offer };
    }
    if (read.offer.disposition === input.disposition) {
      return { kind: input.disposition, transitioned: false, offer: read.offer };
    }
    if (read.offer.disposition !== 'pending') {
      return { kind: 'conflict', offer: read.offer };
    }
    const refused: CustodyOfferV1 = {
      ...read.offer,
      disposition: input.disposition,
      actorRef: input.actorRef,
      dispositionAt: input.dispositionAt,
    };
    const transition = await this.messages.compareAndTransitionCustodyOffer(input.sourceMessageId, {
      expectedSourceMessageRevision: input.sourceMessageRevision,
      expectedOffer: read.offer,
      nextOffer: refused,
    });
    if (transition.kind === 'updated') {
      return { kind: input.disposition, transitioned: true, offer: refused };
    }
    if (transition.kind === 'state_conflict') {
      const current = transition.currentOffer;
      return current?.offerId === input.offerId && current.disposition === input.disposition
        ? { kind: input.disposition, transitioned: false, offer: current }
        : { kind: 'conflict', offer: current };
    }
    return transitionFailure(transition);
  }
}
