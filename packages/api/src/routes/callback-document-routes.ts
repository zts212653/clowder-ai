/** F088 generic document generation and publication. */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RichBlock } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  InvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import { getRichBlockBuffer } from '../domains/cats/services/agents/invocation/RichBlockBuffer.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { PandocService } from '../infrastructure/document/PandocService.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { getDeletedCallbackThreadGuard } from './callback-scope-helpers.js';

const generateDocumentSchema = z.object({
  markdown: z.string().min(1).max(500_000),
  format: z.enum(['pdf', 'docx', 'md']),
  baseName: z.string().min(1).max(200),
});
interface DocumentRouteDeps {
  readonly invocationTracker?: Pick<InvocationTracker, 'getLifecycleResponseMessageId'>;
  readonly registry: InvocationRegistry;
  readonly socketManager: Pick<SocketManager, 'broadcastAgentMessage'>;
  readonly threadStore?: Pick<IThreadStore, 'get'>;
  readonly messageStore?: Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>;
  readonly documentService?: Pick<PandocService, 'generate'>;
}

export function registerCallbackDocumentRoutes(app: FastifyInstance, deps: DocumentRouteDeps): void {
  const renderer = deps.documentService ?? new PandocService(app.log);
  app.post('/api/callbacks/generate-document', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = generateDocumentSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    const deletedThreadGuard = await getDeletedCallbackThreadGuard(deps.threadStore, record.threadId);
    if (deletedThreadGuard) return reply.status(deletedThreadGuard.statusCode).send(deletedThreadGuard.body);
    if (!(await deps.registry.isLatest(record.invocationId))) return { status: 'stale_ignored' };
    const { markdown, baseName, format } = parsed.data;
    const result = await renderer.generate(markdown, baseName, format);
    if (!result) return reply.status(500).send({ error: 'Document generation failed' });
    try {
      const uploadDir = getDefaultUploadDir(process.env.UPLOAD_DIR);
      await mkdir(uploadDir, { recursive: true });
      const name = `doc-${randomBytes(6).toString('hex')}-${result.fileName}`;
      const destPath = resolve(uploadDir, name);
      await copyFile(result.absPath, destPath);
      const fileSize = (await stat(destPath)).size;
      const url = `/uploads/${name}`;
      const fileBlock: RichBlock = {
        id: `file-${randomBytes(4).toString('hex')}`,
        kind: 'file',
        v: 1,
        url,
        fileName: result.fileName,
        mimeType: result.mimeType,
        fileSize,
      };
      const addResult = getRichBlockBuffer().add(record.threadId, record.catId, fileBlock, record.invocationId);
      if (addResult === 'rejected') {
        await unlink(destPath).catch(() => {});
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
        url,
        fileName: result.fileName,
        format: result.format,
        mimeType: result.mimeType,
        fileSize,
      };
    } finally {
      await unlink(result.absPath).catch(() => {});
    }
  });
}
