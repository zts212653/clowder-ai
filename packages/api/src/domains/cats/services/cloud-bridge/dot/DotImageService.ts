import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RichMediaGalleryBlock } from '@cat-cafe/shared';
import sharp from 'sharp';
import { z } from 'zod';
import { MAX_IMAGE_FILE_SIZE, saveImageBufferToUploadDir } from '../../../../../utils/image-storage.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import { isTimelinePublished } from '../../stores/visibility.js';
import type { DotConnectionService } from './DotConnectionService.js';
import type { DotDispatchStore } from './DotDispatchStore.js';
import type { DotReturnService } from './DotReturnService.js';

const assetSchema = z
  .object({
    id: z.string().regex(/^dot_img_[a-f0-9]{64}$/),
    ownerUserId: z.string(),
    threadId: z.string(),
    eventId: z.string(),
    publicationKey: z.string(),
    sha256: z.string().length(64),
    byteSize: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    messageId: z.string().nullable(),
    alt: z.string(),
  })
  .strict();
type DotImageAsset = z.infer<typeof assetSchema>;
const MAX_EVENT_IMAGE_PUBLICATIONS = 8;

export async function validateDotPng(base64: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('invalid_base64');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_IMAGE_FILE_SIZE) throw new Error('image_too_large');
  if (bytes.toString('base64') !== base64) throw new Error('invalid_base64');
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('invalid_png');
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' });
    const meta = await image.metadata();
    if (meta.format !== 'png' || !meta.width || !meta.height || (meta.pages && meta.pages > 1))
      throw new Error('invalid_png');
    await image.stats();
    return { bytes, width: meta.width, height: meta.height };
  } catch {
    throw new Error('invalid_png');
  }
}

/** Retains original bytes and attaches the existing media_gallery to the source-bound reply. */
export class DotImageService {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    private readonly options: {
      directory: string;
      returns: DotReturnService;
      connection: DotConnectionService;
      dispatches: DotDispatchStore;
      messages: Pick<IMessageStore, 'getById' | 'augmentStreamMetadata'>;
      threads: Pick<IThreadStore, 'get'>;
      emit: (input: { ownerUserId: string; threadId: string; messageId: string; block: RichMediaGalleryBlock }) => void;
    },
  ) {}

  async publish(
    secret: string,
    input: { event_id: string; publication_key: string; png_base64: string; alt?: string },
  ) {
    const { state, record } = await this.options.returns.authorise(secret, input.event_id);
    if (!record.sourceReadAt) throw new Error('dot_source_not_read');
    const id = `dot_img_${createHash('sha256')
      .update(JSON.stringify([state.ownerUserId, record.eventId, input.publication_key]))
      .digest('hex')}`;
    // Every image on one event augments the same reply. Serialize the complete
    // publication, not just retries of one asset, around the store's metadata merge.
    const previous = this.pending.get(record.eventId) ?? Promise.resolve();
    const work = previous.then(async () => {
      await this.options.returns.authorise(secret, input.event_id);
      const reserved = await this.reservePublication(record.eventId, id);
      const checked = await validateDotPng(input.png_base64).catch(async (error: unknown) => {
        // Invalid bytes have not reached disk. Failed writes retain their slot
        // so a restart cannot accumulate unaccounted original files.
        if (reserved) await this.releaseInvalidPublication(record.eventId, id);
        throw error;
      });
      const sha256 = createHash('sha256').update(checked.bytes).digest('hex');
      let asset = await this.readMetadata(id);
      if (asset && asset.sha256 !== sha256) throw new Error('dot_publication_conflict');
      if (!asset) {
        const stored = await saveImageBufferToUploadDir({
          buffer: checked.bytes,
          mimeType: 'image/png',
          uploadDir: join(this.options.directory, 'files'),
          filenameStem: id,
          onExists: 'reuse',
        });
        await chmod(stored.absPath, 0o600);
        if (
          createHash('sha256')
            .update(await readFile(stored.absPath))
            .digest('hex') !== sha256
        )
          throw new Error('dot_publication_conflict');
        asset = {
          id,
          ownerUserId: state.ownerUserId,
          threadId: record.threadId,
          eventId: record.eventId,
          publicationKey: input.publication_key,
          sha256,
          byteSize: checked.bytes.length,
          width: checked.width,
          height: checked.height,
          messageId: null,
          alt: input.alt ?? 'dot 原图',
        };
        await this.writeMetadata(asset);
      }
      const persistedBytes = await readFile(join(this.options.directory, 'files', `${id}.png`));
      if (
        persistedBytes.length !== asset.byteSize ||
        createHash('sha256').update(persistedBytes).digest('hex') !== sha256
      )
        throw new Error('dot_image_corrupt');
      // A text reply already posted remains its owner; later images append to it.
      const posted = await this.options.returns.reply(secret, input.event_id, asset.alt);
      await this.options.returns.authorise(secret, input.event_id);
      const block: RichMediaGalleryBlock = {
        id,
        kind: 'media_gallery',
        v: 1,
        items: [{ url: this.url(id), alt: asset.alt }],
      };
      const message = await this.options.messages.getById(posted.messageId);
      if (
        !message ||
        message.catId !== 'gpt-dot' ||
        message.replyTo !== record.sourceMessageId ||
        message.threadId !== record.threadId
      )
        throw new Error('dot_reply_unavailable');
      // Make the authenticated original readable before the gallery becomes visible.
      asset = { ...asset, messageId: posted.messageId };
      await this.writeMetadata(asset);
      const updated = await this.options.messages.augmentStreamMetadata(posted.messageId, {
        extra: { rich: { v: 1, blocks: [block] } },
      });
      if (!updated) throw new Error('dot_reply_unavailable');
      await this.options.dispatches.update(record.eventId, async (latest) => {
        if (!latest) throw new Error('dot_dispatch_unavailable');
        return {
          record: { ...latest, imagePublicationIds: [...new Set([...latest.imagePublicationIds, id])] },
          result: undefined,
        };
      });
      await this.options.connection.recordEvidence(state, 'image');
      this.options.emit({
        ownerUserId: state.ownerUserId,
        threadId: record.threadId,
        messageId: posted.messageId,
        block,
      });
      return {
        publicationId: id,
        messageId: posted.messageId,
        url: this.url(id),
        sha256,
        byteSize: asset.byteSize,
        width: asset.width,
        height: asset.height,
        mimeType: 'image/png',
        original: true,
      };
    });
    const settled = work.catch(() => undefined);
    this.pending.set(record.eventId, settled);
    void settled.finally(() => {
      if (this.pending.get(record.eventId) === settled) this.pending.delete(record.eventId);
    });
    return work;
  }

  private reservePublication(eventId: string, id: string) {
    return this.options.dispatches.update(eventId, async (record) => {
      if (!record) throw new Error('dot_dispatch_unavailable');
      const reserved = new Set([...record.imagePublicationIds, ...(record.imageReservationIds ?? [])]);
      if (reserved.has(id)) return { record, result: false };
      if (reserved.size >= MAX_EVENT_IMAGE_PUBLICATIONS) throw new Error('dot_image_publication_limit');
      reserved.add(id);
      return { record: { ...record, imageReservationIds: [...reserved] }, result: true };
    });
  }

  private releaseInvalidPublication(eventId: string, id: string) {
    return this.options.dispatches.update(eventId, async (record) => {
      if (!record) throw new Error('dot_dispatch_unavailable');
      return {
        record: { ...record, imageReservationIds: record.imageReservationIds?.filter((value) => value !== id) },
        result: undefined,
      };
    });
  }

  async read(id: string, ownerUserId: string) {
    const asset = await this.readMetadata(id);
    if (!asset || asset.ownerUserId !== ownerUserId || !asset.messageId) throw new Error('dot_image_access_denied');
    const thread = await this.options.threads.get(asset.threadId);
    const message = await this.options.messages.getById(asset.messageId);
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
          block.id === id && block.kind === 'media_gallery' && block.items.some((item) => item.url === this.url(id)),
      )
    )
      throw new Error('dot_image_access_denied');
    const bytes = await readFile(join(this.options.directory, 'files', `${id}.png`));
    if (bytes.length !== asset.byteSize || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
      throw new Error('dot_image_corrupt');
    return { bytes, asset };
  }

  private url(id: string) {
    return `/api/plugins/chatgpt-dot/images/${id}.png`;
  }
  private metadataPath(id: string) {
    if (!/^dot_img_[a-f0-9]{64}$/.test(id)) throw new Error('dot_image_id_invalid');
    return join(this.options.directory, `${id}.json`);
  }
  private async readMetadata(id: string): Promise<DotImageAsset | null> {
    try {
      return assetSchema.parse(JSON.parse(await readFile(this.metadataPath(id), 'utf8')));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  private async writeMetadata(asset: DotImageAsset) {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const path = this.metadataPath(asset.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(assetSchema.parse(asset))}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
