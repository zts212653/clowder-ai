/**
 * F088 Phase J2: Document generation callback routes.
 *
 * Endpoint: POST /api/callbacks/generate-document
 * Cat calls this to generate PDF/DOCX/MD from Markdown content.
 * The generated file is saved to uploads/ and a file RichBlock is attached to the message.
 */

import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RichBlock } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { getRichBlockBuffer } from '../domains/cats/services/agents/invocation/RichBlockBuffer.js';
import { PandocService } from '../infrastructure/document/PandocService.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const generateDocumentSchema = z.object({
  /** Markdown content to convert */
  markdown: z.string().min(1).max(500_000),
  /** Desired output format */
  format: z.enum(['pdf', 'docx', 'md']),
  /** Display name for the file (without extension) */
  baseName: z.string().min(1).max(200),
});

export function registerCallbackDocumentRoutes(
  app: FastifyInstance,
  deps: {
    registry: InvocationRegistry;
    socketManager: SocketManager;
  },
): void {
  const pandocService = new PandocService(app.log);

  app.post('/api/callbacks/generate-document', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = generateDocumentSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { markdown, format, baseName } = parsed.data;
    const invocationId = record.invocationId;

    if (!deps.registry.isLatest(invocationId)) {
      return { status: 'stale_ignored' };
    }

    // Generate document via Pandoc
    const result = await pandocService.generate(markdown, baseName, format);
    if (!result) {
      reply.status(500);
      return { error: 'Document generation failed' };
    }

    // Copy generated file to uploads directory (P1-1: ensure dir exists)
    const uploadDir = resolve(process.env.UPLOAD_DIR ?? './uploads');
    await mkdir(uploadDir, { recursive: true });
    const uniqueName = `doc-${randomBytes(6).toString('hex')}-${result.fileName}`;
    const destPath = resolve(uploadDir, uniqueName);
    try {
      await copyFile(result.absPath, destPath);
    } finally {
      // P2: clean up PandocService temp file after copy
      await unlink(result.absPath).catch(() => {});
    }

    const fileStats = await stat(destPath);
    const fileUrl = `/uploads/${uniqueName}`;

    // Create file RichBlock and buffer it (same pattern as create-rich-block)
    const fileBlock: RichBlock = {
      id: `file-${randomBytes(4).toString('hex')}`,
      kind: 'file',
      v: 1,
      url: fileUrl,
      fileName: result.fileName,
      mimeType: result.mimeType,
      fileSize: fileStats.size,
    };

    const isNew = getRichBlockBuffer().add(record.threadId, record.catId as string, fileBlock, invocationId);

    // #454: include invocationId so frontend can exact-match callback to stream bubble
    if (isNew) {
      deps.socketManager.broadcastAgentMessage(
        {
          type: 'system_info' as const,
          catId: record.catId,
          content: JSON.stringify({ type: 'rich_block', block: fileBlock }),
          invocationId,
          timestamp: Date.now(),
        },
        record.threadId,
      );
    }

    return {
      status: 'ok',
      url: fileUrl,
      fileName: result.fileName,
      format: result.format,
      mimeType: result.mimeType,
      fileSize: fileStats.size,
    };
  });
}
