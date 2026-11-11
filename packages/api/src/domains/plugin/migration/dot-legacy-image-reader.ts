import { createHash } from 'node:crypto';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { isTimelinePublished } from '../../cats/services/stores/visibility.js';
import type { FileMessagingMediaLedger } from '../../messaging/media-ledger.js';
import type { FileDotLegacyMigrationAuditStore } from './dot-legacy-migration-audit-store.js';
import type { DotLegacySourceReader, LegacyDotImageMetadata } from './dot-legacy-source-reader.js';

export class DotLegacyImageReader {
  constructor(
    private readonly options: {
      readonly audit: Pick<FileDotLegacyMigrationAuditStore, 'findImage'>;
      readonly ledger: Pick<FileMessagingMediaLedger, 'openVerifiedStream'>;
      readonly messages: Pick<IMessageStore, 'getById'>;
      readonly threads: Pick<IThreadStore, 'get'>;
      readonly source?: Pick<DotLegacySourceReader, 'imageMetadata' | 'imageBytes'>;
    },
  ) {}

  async read(id: string, ownerUserId: string) {
    const migrated = await this.readIfMigrated(id, ownerUserId);
    if (migrated) return migrated;
    if (!this.options.source) throw new Error('dot_image_access_denied');
    const asset = (await this.options.source.imageMetadata()).find((candidate) => candidate.id === id);
    if (!asset) throw new Error('dot_image_access_denied');
    await this.assertVisible(asset, ownerUserId);
    const bytes = await this.options.source.imageBytes(id);
    if (bytes.byteLength !== asset.byteSize || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
      throw new Error('dot_image_corrupt');
    }
    return { bytes, asset };
  }

  async readIfMigrated(id: string, ownerUserId: string) {
    const retained = await this.options.audit.findImage(id);
    if (!retained) return undefined;
    const asset = retained.metadata;
    await this.assertVisible(asset, ownerUserId);
    const verified = await this.options.ledger.openVerifiedStream(retained.hmrId);
    if (!verified || verified.byteLength !== asset.byteSize || verified.mimeType !== 'image/png') {
      verified?.stream.destroy();
      throw new Error('dot_image_corrupt');
    }
    return { stream: verified.stream, asset };
  }

  private async assertVisible(asset: LegacyDotImageMetadata, ownerUserId: string): Promise<void> {
    if (asset.ownerUserId !== ownerUserId || !asset.messageId) throw new Error('dot_image_access_denied');
    const [thread, message] = await Promise.all([
      this.options.threads.get(asset.threadId),
      this.options.messages.getById(asset.messageId),
    ]);
    const url = `/api/plugins/chatgpt-dot/images/${asset.id}.png`;
    if (
      !thread ||
      thread.deletedAt ||
      thread.createdBy !== ownerUserId ||
      !message ||
      message.deletedAt ||
      message.recall ||
      message.userId !== ownerUserId ||
      message.threadId !== asset.threadId ||
      message.catId !== 'gpt-dot' ||
      !isTimelinePublished(message) ||
      (message.visibility === 'whisper' && !message.revealedAt) ||
      !message.extra?.rich?.blocks?.some(
        (block) =>
          block.id === asset.id && block.kind === 'media_gallery' && block.items.some((item) => item.url === url),
      )
    ) {
      throw new Error('dot_image_access_denied');
    }
  }
}
