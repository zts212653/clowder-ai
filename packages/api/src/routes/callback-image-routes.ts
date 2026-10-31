import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import type {
  InvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { stampVisibleTurn } from '../domains/cats/services/agents/invocation/visible-turn.js';
import { publishGeneratedImage } from '../domains/cats/services/agents/providers/generated-image-publication.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isDurableOwnerReadEvidence } from '../domains/cats/services/stores/visibility.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { ImagePublicationConflictError, MAX_IMAGE_FILE_SIZE } from '../utils/image-storage.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const imageSchema = z
  .object({
    sourcePath: z.string().min(1).max(4096),
    publicationKey: z.string().min(1).max(128),
    imageBase64: z
      .string()
      .min(1)
      .max(4 * Math.ceil(MAX_IMAGE_FILE_SIZE / 3)),
    title: z.string().min(1).max(200).optional(),
    alt: z.string().max(2000).optional(),
  })
  .strict();
type ImageInput = z.infer<typeof imageSchema>;
interface ImageRouteDeps {
  registry: Pick<InvocationRegistry, 'verify' | 'isLatest'>;
  messageStore: Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey'>;
  threadStore?: {
    get(
      threadId: string,
    ):
      | { createdBy: string; deletedAt?: number | null }
      | null
      | Promise<{ createdBy: string; deletedAt?: number | null } | null>;
  };
  socketManager: Pick<SocketManager, 'broadcastAgentMessage'>;
  uploadDir?: string;
}
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function admit(deps: ImageRouteDeps, record: InvocationRecord, reply: FastifyReply) {
  const verified = await deps.registry.verify(record.invocationId, record.callbackToken);
  if (!verified.ok || !(await deps.registry.isLatest(record.invocationId))) {
    reply.status(401).send({ error: 'Image publication invocation is no longer current' });
    return false;
  }
  const thread = await deps.threadStore?.get(record.threadId);
  if (!thread || thread.createdBy !== record.userId) {
    reply.status(403).send({ error: 'Current thread is not owned by the invocation owner' });
    return false;
  }
  if (thread.deletedAt) {
    reply.status(410).send({ code: 'THREAD_DELETED', error: 'Thread is deleted' });
    return false;
  }
  return true;
}

async function decodePng(input: ImageInput): Promise<Buffer> {
  const bytes = Buffer.from(input.imageBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_FILE_SIZE || bytes.toString('base64') !== input.imageBase64)
    throw new Error('Expected canonical base64 PNG at most 10 MiB');
  const decoder = sharp(bytes, { limitInputPixels: 16_777_216, animated: false });
  const metadata = await decoder.metadata();
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) throw new Error('Expected a single PNG image');
  await decoder.stats();
  return bytes;
}

function messageProvenance(message: StoredMessage): Record<string, unknown> | undefined {
  const block = message.extra?.rich?.blocks[0];
  const value = block?.kind === 'media_gallery' && 'provenance' in block ? block.provenance : undefined;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function receipt(message: StoredMessage, url: string, isNew: boolean) {
  return {
    status: isNew ? 'published' : 'reused',
    url,
    messageId: message.id,
    threadId: message.threadId,
    revision: String(message.timestamp),
    provenance: messageProvenance(message),
  };
}

/** One member adapter to the existing F172 file writer and durable MessageStore. No Task side effects. */
export function registerCallbackImageRoutes(app: FastifyInstance, deps: ImageRouteDeps): void {
  app.post(
    '/api/callbacks/publish-image',
    { bodyLimit: 4 * Math.ceil(MAX_IMAGE_FILE_SIZE / 3) + 16_384 },
    async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;
      const parsed = imageSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.status(400).send({ error: 'Invalid image publication', details: parsed.error.issues });
      if (!(await admit(deps, record, reply))) return;
      const input = parsed.data;
      let bytes: Buffer;
      try {
        bytes = await decodePng(input);
      } catch {
        return reply.status(400).send({ error: 'Expected a valid single PNG, at most 10 MiB and 16 megapixels' });
      }
      return publishMemberImage(deps, record, input, bytes, reply);
    },
  );
}

async function publishMemberImage(
  deps: ImageRouteDeps,
  record: InvocationRecord,
  input: ImageInput,
  bytes: Buffer,
  reply: FastifyReply,
) {
  const scope = JSON.stringify([record.userId, record.threadId, record.catId, input.publicationKey]);
  const key = `member-image-${digest(scope)}`;
  const requestDigest = digest(
    JSON.stringify([input.sourcePath, digest(bytes), input.title ?? null, input.alt ?? null]),
  );
  const matches = (message: StoredMessage) => {
    const provenance = messageProvenance(message);
    return (
      !message.recall &&
      message.deletedAt === undefined &&
      !message._tombstone &&
      isDurableOwnerReadEvidence(message) &&
      provenance?.requestDigest === requestDigest
    );
  };
  const existing = await deps.messageStore.getByIdempotencyKey(record.userId, record.threadId, key);
  if (existing && !matches(existing))
    return reply.status(409).send({
      error:
        'Publication key names different content or a withdrawn/deleted message; use a new key only for an intended new publication',
    });
  if (!(await admit(deps, record, reply))) return;
  try {
    const image = await publishGeneratedImage({
      sourcePath: input.sourcePath,
      memberBytes: bytes,
      mimeType: 'image/png',
      publicationKey: key,
      provider: 'member',
      toolName: 'cat_cafe_publish_image',
      uploadDir: deps.uploadDir,
      title: input.title,
      alt: input.alt,
    });
    if (!(await admit(deps, record, reply))) return;
    const provenance = {
      ...image.provenance,
      requestDigest,
      actor: { userId: record.userId, threadId: record.threadId, catId: record.catId },
    };
    const block = { ...image.richBlock, provenance };
    const result = await deps.messageStore.appendIdempotent({
      userId: record.userId,
      threadId: record.threadId,
      from: { kind: 'agent', catId: record.catId },
      content: input.title ?? '图片已发布',
      mentions: [],
      origin: 'callback',
      timestamp: Date.now(),
      idempotencyKey: key,
      extra: { isExplicitPost: true, rich: { v: 1, blocks: [block] } },
    });
    if (!matches(result.message))
      return reply.status(409).send({
        error:
          'Publication key names different content or a withdrawn/deleted message; use a new key only for an intended new publication',
      });
    const message = result.message;
    if (!result.idempotent) {
      const stamp = stampVisibleTurn(record.parentInvocationId ?? record.invocationId, record.invocationId);
      deps.socketManager.broadcastAgentMessage(
        {
          type: 'text',
          catId: record.catId,
          content: message.content,
          messageId: message.id,
          origin: 'callback',
          extra: { isExplicitPost: true },
          timestamp: message.timestamp,
          ...stamp,
        },
        record.threadId,
      );
      deps.socketManager.broadcastAgentMessage(
        {
          type: 'system_info',
          catId: record.catId,
          content: JSON.stringify({ type: 'rich_block', block, messageId: message.id }),
          timestamp: message.timestamp,
          ...stamp,
        },
        record.threadId,
      );
    }
    return receipt(message, image.urlPath, !result.idempotent);
  } catch (error) {
    if (error instanceof ImagePublicationConflictError) return reply.status(409).send({ error: error.message });
    throw error;
  }
}
