import { createHash } from 'node:crypto';
import {
  readWorkCoverSchema,
  type SetWorkCover,
  setWorkCoverSchema,
  type VideoProjectAssetVersion,
  type WorkCoverImage,
  type WorkCoverRecord,
  type WorkCoverView,
  type WorkReference,
  workReferenceSchema,
} from '@cat-cafe/shared';
import { MediaOwnerError } from '../../../video-studio/content-owner/media-errors.js';
import type { WorkPrincipal } from '../types.js';
import { coverSourceReadable, resolveCoverPick, type WorkCoverSourcePorts } from './cover-sources.js';
import type { WorkCoverStore } from './cover-store.js';

export interface WorkCoverPorts extends WorkCoverSourcePorts {
  store: WorkCoverStore;
  /** The same authority as the fixed work version: reading the work never implies changing its cover. */
  authorize(reference: WorkReference, principal: WorkPrincipal, permission: 'read' | 'write'): Promise<void>;
  /** Format of the fixed version; only video versions have an adopted cover. */
  mediaType(reference: WorkReference, principal: WorkPrincipal): Promise<string>;
  open(version: VideoProjectAssetVersion): Promise<{ handle: { close(): Promise<void> }; cleanup(): Promise<void> }>;
  /** The work's own conversation, used only to address the existing asset byte route for its owner. */
  threadOf(reference: WorkReference, principal: WorkPrincipal): string;
  changed?(ownerUserId: string): void;
}

export const workCoverImageUrl = (record: WorkCoverRecord) =>
  `/api/works/cover/image?${new URLSearchParams({
    contentRef: record.reference.contentRef,
    ownerRevision: String(record.reference.ownerRevision),
    coverRevision: String(record.coverRevision),
  })}`;

const digest = (value: unknown) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** Adopt, change, clear or restore the cover of one fixed video version; people and cats save the same fact. */
export class WorkCoverService {
  constructor(readonly deps: WorkCoverPorts) {}

  async set(raw: unknown, principal: WorkPrincipal) {
    const command = setWorkCoverSchema.parse(raw);
    const reference = command.reference;
    await this.assertVideo(reference, principal, 'write');
    const requestDigest = digest(command);
    const replay = this.deps.store.replay(principal.userId, reference, command.operationId);
    const choice = replay ? { image: replay.image, basis: replay.basis } : await this.decide(command, principal);
    // Adopting, restoring and replaying all hand this caller one exact picture: its source must still be
    // readable now. A refused write keeps the saved choice; the read projection never stands in for refusal.
    if (choice.image && !(await coverSourceReadable(this.deps, choice.image, principal)))
      throw new MediaOwnerError('media_unavailable');
    // Authority withdrawn after the menu opened still blocks the actual save and its retry.
    await this.deps.authorize(reference, principal, 'write');
    const record = this.deps.store.save({
      principal,
      reference,
      operationId: command.operationId,
      requestDigest,
      expectedCoverRevision: command.expectedCoverRevision,
      ...choice,
    });
    if (!replay) {
      try {
        this.deps.changed?.(principal.userId);
      } catch {
        /* Card refresh notices never change the saved choice. */
      }
    }
    return { status: 'saved' as const, record, cover: await this.view(record, principal) };
  }

  async read(raw: unknown, principal: WorkPrincipal): Promise<WorkCoverView> {
    const command = readWorkCoverSchema.omit({ action: true }).parse(raw);
    await this.assertVideo(command.reference, principal, 'read');
    const record = this.deps.store.get(principal.userId, command.reference, command.coverRevision);
    if (command.coverRevision !== undefined && !record) throw new MediaOwnerError('media_unavailable');
    const view = await this.view(record, principal, command.reference);
    await this.deps.authorize(command.reference, principal, 'read');
    return view;
  }

  /** Open the exact adopted bytes of one cover revision for a reader who can still read its source. */
  async open(raw: WorkReference, coverRevision: number, principal: WorkPrincipal) {
    const reference = workReferenceSchema.parse(raw);
    await this.assertVideo(reference, principal, 'read');
    const image = this.deps.store.get(principal.userId, reference, coverRevision)?.image;
    if (!image || !(await coverSourceReadable(this.deps, image, principal)))
      throw new MediaOwnerError('media_unavailable');
    const opened = await this.deps.open(image.version);
    try {
      // The source may be withdrawn while the snapshot is made; check it again before any byte leaves.
      if (!(await coverSourceReadable(this.deps, image, principal))) throw new MediaOwnerError('media_unavailable');
      await this.deps.authorize(reference, principal, 'read');
      return { opened, image };
    } catch (error) {
      await opened.handle.close();
      await opened.cleanup();
      throw error;
    }
  }

  /** Resolve a new pick now; restoring re-adopts the exact file an earlier revision recorded. */
  private async decide(command: SetWorkCover, principal: WorkPrincipal) {
    const { choice, reference } = command;
    if (choice.mode === 'frame') return { image: null, basis: { kind: 'cleared' as const } };
    if (choice.mode === 'restore') {
      const earlier = this.deps.store.get(principal.userId, reference, choice.coverRevision);
      if (!earlier) throw new MediaOwnerError('media_unavailable');
      return { image: earlier.image, basis: { kind: 'restored' as const, coverRevision: choice.coverRevision } };
    }
    const image: WorkCoverImage = await resolveCoverPick(this.deps, reference, choice.pick, principal);
    return { image, basis: { kind: 'chosen' as const } };
  }

  private async assertVideo(reference: WorkReference, principal: WorkPrincipal, permission: 'read' | 'write') {
    await this.deps.authorize(reference, principal, permission);
    if ((await this.deps.mediaType(reference, principal)) !== 'video/mp4') throw new MediaOwnerError('invalid_media');
  }

  async view(
    record: WorkCoverRecord | null,
    principal: WorkPrincipal,
    fallback?: WorkReference,
  ): Promise<WorkCoverView> {
    const reference = record?.reference ?? fallback!;
    if (!record) return { reference, coverRevision: 0, state: 'none' };
    const base = {
      reference,
      coverRevision: record.coverRevision,
      basis: record.basis,
      actor: record.actor,
      recordedAt: record.recordedAt,
    };
    if (!record.image) return { ...base, state: 'frame' };
    const readable = await coverSourceReadable(this.deps, record.image, principal);
    return {
      ...base,
      state: readable ? 'image' : 'unavailable',
      image: {
        name: record.image.name,
        mediaType: record.image.version.mediaType,
        sha256: record.image.version.sha256,
        origin: record.image.origin,
        url: workCoverImageUrl(record),
      },
    };
  }
}
