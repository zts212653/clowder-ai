import { createHash } from 'node:crypto';
import {
  type EvolutionExplorationRequestV1,
  type EvolutionResolvedExplorationReviewV1,
  evolutionExplorationReviewV1Schema,
  evolutionExplorationSelectionMatches,
  type HarnessHistoryPublicationAttempt,
  type HarnessHistoryPublicationCommand,
  type HarnessHistoryPublicationStatus,
  type HarnessHistoryPublicationVersion,
  harnessHistoryPublicationCommandSchema,
  harnessHistoryPublicationRef,
  refIdentity,
} from '@cat-cafe/shared';
import { unavailableExploration } from '../../read-model/program-exploration.js';
import { type HarnessHistorySource, HarnessHistorySourceError } from './harness-history-git-source.js';
import type {
  HarnessHistoryPublicationSnapshot,
  HarnessHistoryPublicationStore,
} from './harness-history-publication-store.js';
import { mapHarnessHistorySelection } from './harness-history-selection.js';
import { projectRequestReviewHarnessExploration } from './request-review-harness-lineage.js';
import { normalizeRequestReviewHarnessV3UnknownFieldPaths } from './request-review-harness-lineage-v3-schema.js';
import { REQUEST_REVIEW_TARGET_STATE_REF } from './request-review-owner-identity.js';

export class HarnessHistoryPublicationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
export class HarnessHistoryPublicationOwner {
  constructor(
    private readonly options: {
      store: HarnessHistoryPublicationStore;
      source: HarnessHistorySource;
      now?: () => string;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? new Date().toISOString();
  }
  private async baseline(programId: string, snapshot: HarnessHistoryPublicationSnapshot) {
    return (
      snapshot.baselineSourceRevision ??
      (await this.options.store.initializeBaseline(programId, await this.options.source.baseline()))
    );
  }
  private version(
    programId: string,
    sourceRevision: string,
    attempt?: HarnessHistoryPublicationAttempt,
  ): HarnessHistoryPublicationVersion {
    return {
      ref: harnessHistoryPublicationRef(
        programId,
        attempt ? `publication:${attempt.revision}:${sourceRevision}` : `bundled:${sourceRevision}`,
      ),
      sourceRevision,
      revision: attempt?.revision ?? 0,
      bundled: !attempt,
      ...(attempt ? { occurredAt: attempt.occurredAt, actorRef: attempt.actorRef, reason: attempt.reason } : {}),
    };
  }
  private async selected(
    programId: string,
    snapshot: HarnessHistoryPublicationSnapshot,
    input: EvolutionExplorationRequestV1,
  ) {
    const baseline = this.version(programId, await this.baseline(programId, snapshot));
    const current = snapshot.current?.sourceRevision
      ? this.version(programId, snapshot.current.sourceRevision, snapshot.current)
      : baseline;
    if (!input.selectedSourceRef || refIdentity(input.selectedSourceRef) === refIdentity(current.ref))
      return { current, selected: current };
    if (refIdentity(input.selectedSourceRef) === refIdentity(baseline.ref)) return { current, selected: baseline };
    const match = /^publication:(\d+):[a-f0-9]{40}$/.exec(input.selectedSourceRef.version ?? '');
    const attempt = match ? await this.options.store.get(programId, Number(match[1])) : undefined;
    if (attempt?.status === 'published' && attempt.sourceRevision) {
      const selected = this.version(programId, attempt.sourceRevision, attempt);
      if (refIdentity(selected.ref) === refIdentity(input.selectedSourceRef)) return { current, selected };
    }
    throw new HarnessHistoryPublicationError('history_source_not_published', 422);
  }
  async status(input: EvolutionExplorationRequestV1): Promise<HarnessHistoryPublicationStatus> {
    this.assertScope(input);
    const programId = input.programRef.ownerStateRef;
    const snapshot = await this.options.store.read(programId);
    const versions = await this.selected(programId, snapshot, input);
    return {
      schemaVersion: 1,
      programRef: input.programRef,
      objectRef: input.objectRef,
      revision: snapshot.revision,
      ...versions,
      attempts: snapshot.attempts,
      hasMore: snapshot.revision > snapshot.attempts.length,
    };
  }
  private assertScope(input: EvolutionExplorationRequestV1) {
    if (
      input.programRef.ownerFeatureId !== 'F311' ||
      input.objectRef.ownerFeatureId !== 'F100' ||
      input.objectRef.ownerStateRef !== REQUEST_REVIEW_TARGET_STATE_REF
    )
      throw new HarnessHistoryPublicationError('history_object_not_supported', 422);
  }
  private async project(input: EvolutionExplorationRequestV1, version: HarnessHistoryPublicationVersion) {
    const index = await this.options.source.read(version.sourceRevision);
    const projection = projectRequestReviewHarnessExploration(input, index, this.now(), version.ref);
    const parsed = evolutionExplorationReviewV1Schema.safeParse(projection);
    if (!parsed.success || parsed.data.status !== 'resolved') throw new HarnessHistorySourceError('invalid_history');
    return parsed.data;
  }
  async read(input: EvolutionExplorationRequestV1) {
    const status = await this.status(input);
    const projection = await this.project(input, status.selected);
    if (!evolutionExplorationSelectionMatches(projection, input)) {
      const failed = unavailableExploration(input, 'archive_selection_expired');
      return { ...failed, status: 'invalid' as const, recoverySelection: { selectedSourceRef: status.current.ref } };
    }
    let update: HarnessHistoryPublicationStatus['selectionUpdate'];
    if (refIdentity(status.current.ref) !== refIdentity(status.selected.ref)) {
      const catalog = await this.project({ programRef: input.programRef, objectRef: input.objectRef }, status.current);
      // Resolve the target refs first, then fetch exactly those target details for the body comparison.
      const mapped = mapHarnessHistorySelection(projection, catalog, input);
      const detailed = mapped.nextSelection
        ? await this.project({ ...input, ...mapped.nextSelection }, status.current)
        : catalog;
      update = mapHarnessHistorySelection(projection, detailed, input);
    }
    const { schemaVersion: _schema, programRef: _program, objectRef: _object, ...publication } = status;
    return {
      ...projection,
      publication: {
        ...publication,
        attempts: status.attempts.map(
          ({
            revision,
            action,
            status: result,
            actorRef,
            originRef,
            reason,
            occurredAt,
            failureCode,
            ignoredFieldPaths,
          }) => ({
            revision,
            action,
            status: result,
            actorRef,
            originRef,
            reason,
            occurredAt,
            ...(failureCode ? { failureCode } : {}),
            ...(ignoredFieldPaths?.length ? { ignoredFieldPaths } : {}),
          }),
        ),
        ...(update ? { selectionUpdate: update } : {}),
      },
    } satisfies EvolutionResolvedExplorationReviewV1;
  }
  private async validateSource(
    input: EvolutionExplorationRequestV1,
    command: HarnessHistoryPublicationCommand,
    baseline: string,
  ) {
    const programId = input.programRef.ownerStateRef;
    if (command.action === 'restore') {
      const previous =
        command.restoreRevision === 0 ? undefined : await this.options.store.get(programId, command.restoreRevision);
      const revision =
        command.restoreRevision === 0
          ? baseline
          : previous?.status === 'published'
            ? previous.sourceRevision
            : undefined;
      if (!revision) throw new HarnessHistorySourceError('restore_not_found');
      await this.project(input, this.version(programId, revision));
      return {
        sourceRevision: revision,
        ignoredFieldPaths:
          (await this.options.source.ignoredFieldPaths?.(revision)) ?? previous?.ignoredFieldPaths ?? [],
      };
    }
    const index = await this.options.source.acquire(command.sourceRevision);
    const projected = projectRequestReviewHarnessExploration(
      input,
      index,
      this.now(),
      this.version(programId, command.sourceRevision).ref,
    );
    if (!evolutionExplorationReviewV1Schema.safeParse(projected).success)
      throw new HarnessHistorySourceError('invalid_history');
    return {
      sourceRevision: command.sourceRevision,
      ignoredFieldPaths: (await this.options.source.ignoredFieldPaths?.(command.sourceRevision)) ?? [],
    };
  }
  /** Transport service must supply a revalidated active invocation; no actor fields come from the body. */
  async publish(
    input: EvolutionExplorationRequestV1,
    raw: HarnessHistoryPublicationCommand,
    actor: { actorRef: string; originRef: string },
  ) {
    this.assertScope(input);
    const command = harnessHistoryPublicationCommandSchema.parse(raw);
    const programId = input.programRef.ownerStateRef;
    const digest = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const replay = await this.options.store.replay(programId, actor.actorRef, command.clientMessageId, digest);
    if (replay) return replay;
    const snapshot = await this.options.store.read(programId);
    if (snapshot.revision !== command.expectedRevision) return { outcome: 'conflict' as const };
    const baseline = await this.baseline(programId, snapshot);
    let sourceRevision: string | undefined = command.action === 'publish' ? command.sourceRevision : undefined;
    let ignoredFieldPaths: string[] = [];
    let failureCode: HarnessHistoryPublicationAttempt['failureCode'];
    try {
      const validated = await this.validateSource(input, command, baseline);
      sourceRevision = validated.sourceRevision;
      ignoredFieldPaths = normalizeRequestReviewHarnessV3UnknownFieldPaths(validated.ignoredFieldPaths);
    } catch (error) {
      if (!(error instanceof HarnessHistorySourceError)) throw error;
      failureCode = error.code;
    }
    const attempt: HarnessHistoryPublicationAttempt = {
      revision: snapshot.revision + 1,
      clientMessageId: command.clientMessageId,
      action: command.action,
      status: failureCode ? 'failed' : 'published',
      ...actor,
      reason: command.reason,
      occurredAt: this.now(),
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(command.action === 'restore' ? { restoreRevision: command.restoreRevision } : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(ignoredFieldPaths.length ? { ignoredFieldPaths } : {}),
    };
    return this.options.store.append({
      programId,
      expectedRevision: command.expectedRevision,
      baselineSourceRevision: baseline,
      commandDigest: digest,
      attempt,
    });
  }
}
