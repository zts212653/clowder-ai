/** F088 document producer; admitted Collective Work writes only immutable scoped UTF8 MD assets. */
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { RichBlock } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  InvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { getRichBlockBuffer } from '../domains/cats/services/agents/invocation/RichBlockBuffer.js';
import { collectAllThreadMessages } from '../domains/cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { isDurableOwnerReadEvidence } from '../domains/cats/services/stores/visibility.js';
import { readBoundedPackageFile } from '../domains/plugin/external-runtime/bounded-package-file.js';
import {
  type CollectiveDocumentScope,
  collectiveDocumentFileName,
  serializeCollectiveDocumentPublication,
} from '../infrastructure/document/collective-document-scope.js';
import { type GeneratedDocument, PandocService } from '../infrastructure/document/PandocService.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { getDeletedCallbackThreadGuard } from './callback-scope-helpers.js';

const WORK_DOCUMENT_BUDGET = 65_536;
const generateDocumentSchema = z.object({
  markdown: z.string().min(1).max(500_000),
  format: z.enum(['pdf', 'docx', 'md']),
  baseName: z.string().min(1).max(200),
});
interface DocumentRouteDeps {
  readonly registry: InvocationRegistry;
  readonly socketManager: Pick<SocketManager, 'broadcastAgentMessage'>;
  readonly threadStore?: Pick<IThreadStore, 'get'>;
  readonly messageStore?: Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>;
  readonly documentService?: Pick<PandocService, 'generate'>;
}
type DocumentInput = z.infer<typeof generateDocumentSchema>;
interface PublicationAsset {
  readonly result: GeneratedDocument;
  readonly uploadDir: string;
  readonly name: string;
  readonly scope?: CollectiveDocumentScope;
  readonly bytes?: Buffer;
}

export function registerCallbackDocumentRoutes(app: FastifyInstance, deps: DocumentRouteDeps): void {
  const pandocService = deps.documentService ?? new PandocService(app.log);
  app.post('/api/callbacks/generate-document', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = generateDocumentSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    const scope = documentScope(record);
    if (record.toolExecutionPolicy?.mode === 'collective_work' && !scope)
      return reply
        .status(403)
        .send({ code: 'WORK_DOCUMENT_SCOPE_REQUIRED', error: 'Current Work binding is required' });
    if (scope && !isSupportedWorkDocument(parsed.data))
      return reply.status(400).send({
        code: 'WORK_DOCUMENT_CONTENT_UNSUPPORTED',
        error: 'Work documents require UTF8 MD at most 65536 bytes',
      });
    const deletedThreadGuard = await getDeletedCallbackThreadGuard(deps.threadStore, record.threadId);
    if (deletedThreadGuard) return reply.status(deletedThreadGuard.statusCode).send(deletedThreadGuard.body);
    if (!(await deps.registry.isLatest(record.invocationId))) return { status: 'stale_ignored' };
    return generateAndPublishDocument(deps, pandocService, reply, record, parsed.data, scope);
  });
}

function documentScope(record: InvocationRecord): CollectiveDocumentScope | undefined {
  const binding = record.collectiveWorkBinding;
  if (!binding) return undefined;
  return {
    userId: record.userId,
    taskId: binding.taskId,
    executionRevision: binding.executionRevision ?? 1,
    resultRevision: binding.resultRevision,
  };
}

function isSupportedWorkDocument(input: DocumentInput): boolean {
  return (
    input.format === 'md' &&
    Buffer.byteLength(input.markdown, 'utf8') <= WORK_DOCUMENT_BUDGET &&
    !input.markdown.includes('\0')
  );
}

async function generateAndPublishDocument(
  deps: DocumentRouteDeps,
  renderer: Pick<PandocService, 'generate'>,
  reply: FastifyReply,
  record: InvocationRecord,
  input: DocumentInput,
  scope?: CollectiveDocumentScope,
) {
  let result: GeneratedDocument | null;
  try {
    // F088's real renderer runs before the per-file publication fence.
    const renderBaseName = scope
      ? collectiveDocumentFileName(scope, Buffer.from(input.markdown, 'utf8')).slice(0, -3)
      : input.baseName;
    result = await renderer.generate(input.markdown, renderBaseName, input.format);
    if (result && scope)
      result = { ...result, fileName: `${input.baseName.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')}.md` };
  } catch (error) {
    if (!scope) throw error;
    return reply
      .status(500)
      .send({ code: 'WORK_DOCUMENT_RENDER_FAILED', error: 'Work document generation is unavailable' });
  }
  if (!result) return reply.status(500).send({ error: 'Document generation failed' });
  return transferDocument(deps, reply, record, result, input.markdown, scope);
}

async function transferDocument(
  deps: DocumentRouteDeps,
  reply: FastifyReply,
  record: InvocationRecord,
  result: GeneratedDocument,
  markdown: string,
  scope?: CollectiveDocumentScope,
) {
  try {
    const uploadDir = getDefaultUploadDir(process.env.UPLOAD_DIR);
    await mkdir(uploadDir, { recursive: true });
    const bytes = scope
      ? await readBoundedPackageFile(dirname(result.absPath), basename(result.absPath), WORK_DOCUMENT_BUDGET)
      : undefined;
    if (bytes && !bytes.equals(Buffer.from(markdown, 'utf8')))
      return reply
        .status(409)
        .send({ code: 'WORK_DOCUMENT_FILE_CONFLICT', error: 'Generated Work document bytes changed' });
    const name =
      scope && bytes
        ? collectiveDocumentFileName(scope, bytes)
        : `doc-${randomBytes(6).toString('hex')}-${result.fileName}`;
    const publish = () => publishDocument(deps, reply, record, { result, uploadDir, name, scope, bytes });
    return scope ? await serializeCollectiveDocumentPublication(resolve(uploadDir, name), publish) : await publish();
  } catch (error) {
    if (!scope) throw error;
    return reply
      .status(409)
      .send({ code: 'WORK_DOCUMENT_FILE_CONFLICT', error: 'Work document file is unavailable or changed' });
  } finally {
    await unlink(result.absPath).catch(() => {});
  }
}

function fileAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

async function copyDocument(asset: PublicationAsset): Promise<boolean> {
  try {
    if (asset.scope) {
      if (!asset.bytes) throw new Error('Validated Work document bytes are unavailable');
      await writeFile(resolve(asset.uploadDir, asset.name), asset.bytes, { flag: 'wx', mode: 0o600 });
    } else await copyFile(asset.result.absPath, resolve(asset.uploadDir, asset.name));
    return true;
  } catch (error) {
    if (!asset.scope || !fileAlreadyExists(error)) throw error;
    return false;
  }
}

async function isCurrentDocumentAuthority(deps: DocumentRouteDeps, record: InvocationRecord, asset: PublicationAsset) {
  if (!asset.scope) return true;
  const actual = await readBoundedPackageFile(asset.uploadDir, asset.name, WORK_DOCUMENT_BUDGET);
  if (!asset.bytes || !actual.equals(asset.bytes)) throw new Error('Scoped document asset changed');
  const verified = await deps.registry.verify(record.invocationId, record.callbackToken);
  return verified.ok && (await deps.registry.isLatest(record.invocationId));
}

async function publishDocument(
  deps: DocumentRouteDeps,
  reply: FastifyReply,
  record: InvocationRecord,
  asset: PublicationAsset,
) {
  const { result, uploadDir, name, scope, bytes } = asset;
  const destPath = resolve(uploadDir, name);
  let created = false;
  try {
    created = await copyDocument(asset);
    if (!(await isCurrentDocumentAuthority(deps, record, asset))) {
      if (created) await unlink(destPath).catch(() => {});
      return reply.status(409).send({
        code: 'WORK_DOCUMENT_AUTHORITY_CHANGED',
        error: 'Current Work authority changed before publication',
      });
    }
    const fileSize = bytes?.length ?? (await stat(destPath)).size;
    const fileUrl = `/uploads/${name}`;
    const fileBlock: RichBlock = {
      id: scope
        ? `file-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`
        : `file-${randomBytes(4).toString('hex')}`,
      kind: 'file',
      v: 1,
      url: fileUrl,
      fileName: result.fileName,
      mimeType: result.mimeType,
      fileSize,
    };
    const buffer = getRichBlockBuffer();
    const alreadyPublished = scope && !created && (await hasScopedPublication(deps, record, fileBlock));
    const addResult = alreadyPublished
      ? 'duplicate'
      : buffer.add(record.threadId, record.catId, fileBlock, record.invocationId);
    if (addResult === 'rejected') {
      if (created) await unlink(destPath).catch(() => {});
      return reply
        .status(409)
        .send({ code: 'RICH_BLOCK_INVOCATION_COMPLETE', error: 'Invocation has already completed' });
    }
    if (addResult === 'added')
      deps.socketManager.broadcastAgentMessage(
        {
          type: 'system_info',
          catId: record.catId,
          content: JSON.stringify({ type: 'rich_block', block: fileBlock }),
          invocationId: record.invocationId,
          timestamp: Date.now(),
        },
        record.threadId,
      );
    return {
      status: 'ok',
      url: fileUrl,
      fileName: result.fileName,
      format: result.format,
      mimeType: result.mimeType,
      fileSize,
    };
  } catch (error) {
    if (!scope) throw error;
    if (created) await unlink(destPath).catch(() => {});
    return reply
      .status(409)
      .send({ code: 'WORK_DOCUMENT_FILE_CONFLICT', error: 'Scoped Work document file is unavailable or changed' });
  }
}

async function hasScopedPublication(deps: DocumentRouteDeps, record: InvocationRecord, block: RichBlock) {
  if (getRichBlockBuffer().hasBlock(record.threadId, block.id)) return true;
  if (!deps.messageStore) throw new Error('Durable Work publication lookup is unavailable');
  const messages = await collectAllThreadMessages(deps.messageStore, record.threadId, record.userId);
  if (
    messages.some(
      (message) =>
        !message.recall &&
        !message._tombstone &&
        isDurableOwnerReadEvidence(message) &&
        message.extra?.rich?.blocks.some(
          (published) => published.kind === 'file' && block.kind === 'file' && published.url === block.url,
        ),
    )
  )
    return true;
  return false;
}
