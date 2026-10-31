import { createHash } from 'node:crypto';
import {
  type ArtifactReviewAnchor,
  importWorkContextSchema,
  type SetWorkContext,
  setWorkContextSchema,
  type WorkContextRecord,
  type WorkReference,
  type WorkVideoContext,
  workReferenceSchema,
} from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkContextSource } from './context-source.js';
import type { WorkContextStore } from './context-store.js';
import type { WorkPrincipal } from './service.js';
import type { VerifyWorkSourceBinding, WorkSourceBinding } from './source-binding.js';

export class WorkVideoContextService {
  constructor(
    private readonly deps: {
      store: WorkContextStore;
      verifyBinding?: VerifyWorkSourceBinding;
      verifyAssets?(context: WorkVideoContext, principal: WorkPrincipal, retained?: WorkVideoContext): Promise<void>;
      assertAssetSelections?(context: WorkVideoContext, owner: string, retained?: WorkVideoContext): void;
      contextSource?: WorkContextSource;
      authorize(reference: WorkReference, principal: WorkPrincipal, permission: 'read' | 'write'): Promise<void>;
      media(
        reference: WorkReference,
        principal: WorkPrincipal,
      ): Promise<{
        kind: string;
        streamId: string;
        startTick: number;
        durationTicks: number;
      }>;
    },
  ) {}

  async read(raw: WorkReference, principal: WorkPrincipal, revision?: number) {
    const reference = workReferenceSchema.parse(raw);
    await this.deps.authorize(reference, principal, 'read');
    const record = this.deps.store.get(principal.userId, reference, revision);
    await this.verifyBinding(reference, record?.context.sourceBinding, principal);
    await this.deps.authorize(reference, principal, 'read');
    return record;
  }

  /** Recheck a request's immutable parsed snapshot without decoding the entire context again. */
  async revalidate(record: WorkContextRecord, principal: WorkPrincipal) {
    await this.deps.authorize(record.reference, principal, 'read');
    await this.verifyBinding(record.reference, record.context.sourceBinding, principal);
    await this.deps.authorize(record.reference, principal, 'read');
  }

  /** Validate a citation against its retained row, never today's extractor output. */
  async verifyStory(reference: WorkReference, anchor: ArtifactReviewAnchor, principal: WorkPrincipal) {
    if (anchor.kind !== 'video-range' || !anchor.storyEvidence) return;
    const evidence = anchor.storyEvidence;
    const record = await this.read(reference, principal, evidence.metadataRevision);
    const row = record?.context.story.find((item) => item.id === evidence.paragraphId);
    if (
      !row ||
      row.streamId !== anchor.streamId ||
      row.startPts !== anchor.startTick ||
      row.endPts !== anchor.endTick ||
      (row.text || row.title) !== evidence.quote
    )
      throw new MediaOwnerError('invalid_media');
  }

  async save(raw: unknown, principal: WorkPrincipal) {
    const command = setWorkContextSchema.parse(raw);
    return this.saveResolved(command, principal, this.digest(command));
  }

  async import(raw: unknown, principal: WorkPrincipal) {
    const command = importWorkContextSchema.parse(raw);
    await this.deps.authorize(command.reference, principal, 'write');
    const requestDigest = this.digest(command);
    const replay = this.deps.store.replay(principal.userId, command.reference, command.operationId);
    if (replay)
      return this.saveResolved(
        { ...command, action: 'set-context', context: replay.context },
        principal,
        requestDigest,
      );
    if (!this.deps.contextSource) throw new MediaOwnerError('media_unavailable');
    const source = await this.deps.contextSource(command.source, principal);
    const resolved = setWorkContextSchema.parse({
      action: 'set-context',
      reference: command.reference,
      operationId: command.operationId,
      expectedMetadataRevision: command.expectedMetadataRevision,
      context: source.context,
    });
    return this.saveResolved(resolved, principal, requestDigest, source.revalidate);
  }

  private digest(value: unknown) {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
  }

  private async saveResolved(
    command: SetWorkContext,
    principal: WorkPrincipal,
    requestDigest: string,
    revalidate?: () => Promise<void>,
  ) {
    await this.deps.authorize(command.reference, principal, 'write');
    await this.verifyBinding(command.reference, command.context.sourceBinding, principal);
    const replay = this.deps.store.replay(principal.userId, command.reference, command.operationId);
    if (replay) {
      await this.deps.authorize(command.reference, principal, 'write');
      return this.deps.store.save(command, principal, requestDigest);
    }
    const retained = this.deps.store.get(principal.userId, command.reference)?.context;
    if (
      command.context.assets.some((row) => row.bindingSelection) &&
      (!this.deps.verifyAssets || !this.deps.assertAssetSelections)
    )
      throw new MediaOwnerError('access_denied');
    await this.deps.verifyAssets?.(command.context, principal, retained);
    const media = await this.deps.media(command.reference, principal);
    if (
      media.kind !== 'video' ||
      [...command.context.story, ...(command.context.chapters ?? [])].some(
        (row) =>
          row.streamId !== media.streamId ||
          row.startPts < media.startTick ||
          row.endPts > media.startTick + media.durationTicks,
      )
    )
      throw new MediaOwnerError('invalid_media');
    await this.verifyBinding(command.reference, command.context.sourceBinding, principal);
    await revalidate?.();
    await this.deps.authorize(command.reference, principal, 'write');
    return this.deps.store.save(command, principal, requestDigest, () =>
      this.deps.assertAssetSelections?.(command.context, principal.userId, retained),
    );
  }

  private async verifyBinding(
    reference: WorkReference,
    binding: WorkSourceBinding | undefined,
    principal: WorkPrincipal,
  ) {
    if (!binding) return;
    if (!this.deps.verifyBinding) throw new MediaOwnerError('access_denied');
    await this.deps.verifyBinding(reference, binding, principal);
  }
}
