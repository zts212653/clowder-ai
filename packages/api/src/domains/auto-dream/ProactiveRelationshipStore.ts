import {
  attachCanonicalMessage,
  getProactiveVisit,
  listPendingCanonicalDeliveries,
} from './proactive-delivery-operations.js';
import { findNaturalProactiveEchoBySource, recordNaturalProactiveEcho } from './proactive-natural-echo-operations.js';
import type {
  AttachCanonicalMessageInput,
  AttachCanonicalMessageResult,
  NaturalProactiveEchoInput,
  ProactiveEchoRecord,
  ProactiveIntentRecord,
  ProactiveRecordListOptions,
  ProactiveVisitProjectionInput,
  ProactiveVisitRecord,
} from './proactive-relationship-contract.js';
import { requireProactiveIntent } from './proactive-relationship-operations.js';
import {
  cancelProactiveVisitUnseen,
  listProactiveEchoes,
  listProactiveIntents,
  listProactiveVisits,
  listUnprojectedProactiveVisits,
  markProactiveVisitProjected,
  recordProactiveEcho,
} from './proactive-visit-operations.js';
import type { AutoDreamStoreContext } from './store-context.js';

export class ProactiveRelationshipStore {
  constructor(private readonly getContext: () => AutoDreamStoreContext) {}

  async listIntents(
    ownerUserId: string,
    catId: string,
    options: ProactiveRecordListOptions<ProactiveIntentRecord['status']> = {},
  ): Promise<ProactiveIntentRecord[]> {
    return listProactiveIntents(this.getContext(), ownerUserId, catId, options);
  }

  async getIntent(ownerUserId: string, catId: string, intentId: string): Promise<ProactiveIntentRecord> {
    return requireProactiveIntent(this.getContext(), ownerUserId, catId, intentId);
  }

  async listVisits(
    ownerUserId: string,
    catId: string,
    options: ProactiveRecordListOptions<ProactiveVisitRecord['status']> = {},
  ): Promise<ProactiveVisitRecord[]> {
    return listProactiveVisits(this.getContext(), ownerUserId, catId, options);
  }

  async getVisit(ownerUserId: string, catId: string, visitId: string): Promise<ProactiveVisitRecord> {
    return getProactiveVisit(this.getContext(), ownerUserId, catId, visitId);
  }

  async listPendingDeliveries(ownerUserId: string, limit = 100): Promise<ProactiveVisitRecord[]> {
    return listPendingCanonicalDeliveries(this.getContext(), ownerUserId, limit);
  }

  async listUnprojectedVisits(ownerUserId: string, limit = 100): Promise<ProactiveVisitRecord[]> {
    return listUnprojectedProactiveVisits(this.getContext(), ownerUserId, limit);
  }

  async attachCanonicalMessage(
    ownerUserId: string,
    catId: string,
    input: AttachCanonicalMessageInput,
  ): Promise<AttachCanonicalMessageResult> {
    return attachCanonicalMessage(this.getContext(), ownerUserId, catId, input);
  }

  async listEchoes(
    ownerUserId: string,
    catId: string,
    options: { limit?: number } = {},
  ): Promise<ProactiveEchoRecord[]> {
    return listProactiveEchoes(this.getContext(), ownerUserId, catId, options);
  }

  async markProjected(
    ownerUserId: string,
    catId: string,
    input: ProactiveVisitProjectionInput,
  ): Promise<ProactiveVisitRecord> {
    return markProactiveVisitProjected(this.getContext(), ownerUserId, catId, input);
  }

  async cancelUnseen(ownerUserId: string, catId: string, visitId: string): Promise<ProactiveVisitRecord> {
    return cancelProactiveVisitUnseen(this.getContext(), ownerUserId, catId, visitId);
  }

  async recordEcho(ownerUserId: string, catId: string, input: unknown): Promise<ProactiveEchoRecord> {
    return recordProactiveEcho(this.getContext(), ownerUserId, catId, input);
  }

  async findNaturalEchoBySource(
    ownerUserId: string,
    sourceThreadId: string,
    sourceMessageId: string,
  ): Promise<ProactiveEchoRecord | null> {
    return findNaturalProactiveEchoBySource(this.getContext(), ownerUserId, sourceThreadId, sourceMessageId);
  }

  async recordNaturalEcho(
    ownerUserId: string,
    catId: string,
    input: NaturalProactiveEchoInput,
  ): Promise<ProactiveEchoRecord> {
    return recordNaturalProactiveEcho(this.getContext(), ownerUserId, catId, input);
  }
}

export type {
  AttachCanonicalMessageInput,
  AttachCanonicalMessageResult,
  ForegroundBudgetClaimState,
  NaturalProactiveEchoInput,
  ProactiveEchoKind,
  ProactiveEchoRecord,
  ProactiveIntentRecord,
  ProactiveIntentStatus,
  ProactiveRecordListOptions,
  ProactiveSettlementState,
  ProactiveSurfaceRef,
  ProactiveVisibilityBlock,
  ProactiveVisitProjectionInput,
  ProactiveVisitRecord,
  ProactiveVisitStatus,
} from './proactive-relationship-contract.js';
