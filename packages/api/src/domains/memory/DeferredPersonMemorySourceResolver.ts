import {
  type DeferredPersonMemoryResolvedSource,
  type DeferredPersonMemorySourceInput,
  deferredPersonMemoryResolvedSourceSchema,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import {
  digestPersonMemorySourceMaterial,
  eligibleOwnerMessage,
  explicitlyConfirmsAccuracy,
  ownerMessageAttachmentBlock,
  ownerMessageSourceRef,
} from './people/PersonMemorySourceBundleResolver.js';
import { canonicalizeDeferredPersonMemoryCoordinates } from './people/person-memory-delta-lineage.js';

export type DeferredPersonMemorySourceResolution =
  | {
      status: 'resolved';
      coordinates: DeferredPersonMemoryResolvedSource[];
      bundleDigest: string;
      ready: boolean;
    }
  | { status: 'invalid'; error: string };

export class DeferredPersonMemorySourceResolver {
  constructor(private readonly messageStore: Pick<IMessageStore, 'getById'>) {}

  async resolve(
    sources: readonly DeferredPersonMemorySourceInput[],
    ownerUserId: string,
  ): Promise<DeferredPersonMemorySourceResolution> {
    const coordinates: DeferredPersonMemoryResolvedSource[] = [];
    let ready = true;
    for (const source of sources) {
      const message = await this.messageStore.getById(source.messageId);
      if (!eligibleOwnerMessage(message, { ownerUserId })) {
        return { status: 'invalid', error: 'source_not_eligible' };
      }
      if (source.kind === 'message') {
        coordinates.push(this.resolveMessage(message));
        continue;
      }
      const resolved = await this.resolveAttachment(source, message, ownerUserId);
      if (resolved.status === 'invalid') return resolved;
      coordinates.push(resolved.coordinate);
      ready = ready && resolved.confirmed;
    }
    const canonical = canonicalizeDeferredPersonMemoryCoordinates(coordinates);
    if (canonical.status === 'duplicate') {
      return { status: 'invalid', error: 'duplicate_source_coordinate' };
    }
    return {
      status: 'resolved',
      coordinates: canonical.coordinates,
      bundleDigest: digestPersonMemorySourceMaterial(
        canonical.coordinates.map((coordinate) => ({
          kind: coordinate.kind,
          sourceRef: coordinate.sourceRef,
          ...(coordinate.kind === 'message_attachment'
            ? {
                attachmentLocator: coordinate.attachmentLocator,
                confirmationSourceRef: coordinate.confirmationSourceRef,
              }
            : {}),
          resolvedDigest: coordinate.resolvedDigest,
        })),
      ),
      ready,
    };
  }

  async revalidate(
    sources: readonly DeferredPersonMemorySourceInput[],
    ownerUserId: string,
    expectedBundleDigest: string,
  ): Promise<DeferredPersonMemorySourceResolution> {
    const current = await this.resolve(sources, ownerUserId);
    if (current.status === 'invalid') return current;
    return current.bundleDigest === expectedBundleDigest ? current : { status: 'invalid', error: 'source_drift' };
  }

  private resolveMessage(message: StoredMessage): DeferredPersonMemoryResolvedSource {
    return deferredPersonMemoryResolvedSourceSchema.parse({
      kind: 'message',
      sourceRef: ownerMessageSourceRef(message),
      resolvedDigest: digestPersonMemorySourceMaterial(message.content),
    });
  }

  private async resolveAttachment(
    source: Extract<DeferredPersonMemorySourceInput, { kind: 'message_attachment' }>,
    message: StoredMessage,
    ownerUserId: string,
  ): Promise<
    | { status: 'resolved'; coordinate: DeferredPersonMemoryResolvedSource; confirmed: boolean }
    | { status: 'invalid'; error: string }
  > {
    const block = ownerMessageAttachmentBlock(message, source);
    if (!block) return { status: 'invalid', error: 'attachment_not_available' };
    let confirmation: StoredMessage | null = null;
    if (source.confirmationMessageId) {
      confirmation = await this.messageStore.getById(source.confirmationMessageId);
      if (!eligibleOwnerMessage(confirmation, { ownerUserId }) || !explicitlyConfirmsAccuracy(confirmation)) {
        return { status: 'invalid', error: 'invalid_attachment_confirmation' };
      }
    }
    return {
      status: 'resolved',
      coordinate: deferredPersonMemoryResolvedSourceSchema.parse({
        kind: 'message_attachment',
        sourceRef: ownerMessageSourceRef(message),
        attachmentLocator: source.attachmentLocator,
        resolvedDigest: digestPersonMemorySourceMaterial(block),
        ...(confirmation ? { confirmationSourceRef: ownerMessageSourceRef(confirmation) } : {}),
      }),
      confirmed: confirmation !== null,
    };
  }
}
