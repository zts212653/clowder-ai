/**
 * Multipart Request Parser
 * 解析 multipart/form-data 请求，提取文本字段和图片文件。
 * 从 messages.ts 提取，降低文件复杂度。
 */

import type { FileContent, ImageContent, MessageContent } from '@cat-cafe/shared';
import type { Multipart } from '@fastify/multipart';
import { isImageFile, saveUploadedFiles, type UploadFileEntry } from '../utils/file-storage.js';
import { ImageUploadError, saveUploadedImages, type UploadImageFile } from './image-upload.js';
import { buildMessageContentBlocks, sendMessageSchema } from './messages.schema.js';

export type ParsedMultipart =
  | {
      content: string;
      userId?: string;
      threadId?: string;
      idempotencyKey?: string;
      contentBlocks: MessageContent[];
      visibility?: string;
      whisperTo?: string[];
      deliveryMode?: 'immediate' | 'queue' | 'force';
      messageDisposition?: 'continue_current' | 'next_work';
      /** #699: ID of message being replied to (quote). */
      replyTo?: string;
    }
  | { error: string };

/** Parse multipart request into validated message fields + contentBlocks */
export async function parseMultipart(
  request: { parts: () => AsyncIterableIterator<Multipart> },
  uploadDir: string,
): Promise<ParsedMultipart> {
  // F35: Use string | string[] to support multi-value fields like whisperTo
  const fields: Record<string, string | string[]> = {};
  const imageFiles: UploadImageFile[] = [];
  const otherFiles: UploadFileEntry[] = [];

  for await (const part of request.parts()) {
    if (part.type === 'field' && typeof part.value === 'string') {
      const existing = fields[part.fieldname];
      if (existing !== undefined) {
        fields[part.fieldname] = Array.isArray(existing) ? [...existing, part.value] : [existing, part.value];
      } else {
        fields[part.fieldname] = part.value;
      }
    } else if (part.type === 'file') {
      const buffer = await part.toBuffer();
      const entry = {
        filename: part.filename,
        mimetype: part.mimetype,
        toBuffer: async () => buffer,
      };
      if (isImageFile(part.mimetype)) {
        imageFiles.push(entry);
      } else {
        otherFiles.push(entry);
      }
    }
  }

  // F35: Normalize whisperTo — single value becomes array for Zod validation
  if (fields.whisperTo !== undefined && !Array.isArray(fields.whisperTo)) {
    fields.whisperTo = [fields.whisperTo];
  }

  // F294 v1 deliberately admits Bundle carriers only through JSON. Detect the
  // reserved field explicitly so multipart cannot degrade into an ordinary
  // message or surface an ambiguous generic validation error.
  if (fields.messageBundle !== undefined) {
    return { error: 'Message Bundle does not support multipart uploads' };
  }

  const parseResult = sendMessageSchema.safeParse(fields);
  if (!parseResult.success) {
    return { error: 'Invalid form fields' };
  }

  const { content, contextAttachments, userId, threadId, idempotencyKey } = parseResult.data;
  const uploadedContent: Array<ImageContent | FileContent> = [];

  const totalFiles = imageFiles.length + otherFiles.length;
  if (totalFiles > 0) {
    try {
      if (imageFiles.length > 0) {
        const savedImages = await saveUploadedImages(imageFiles, uploadDir);
        for (const img of savedImages) {
          uploadedContent.push(img.content as ImageContent);
        }
      }
      if (otherFiles.length > 0) {
        const savedFiles = await saveUploadedFiles(otherFiles, uploadDir);
        for (const f of savedFiles) {
          uploadedContent.push(f.content as FileContent);
        }
      }
    } catch (err) {
      if (err instanceof ImageUploadError) {
        return { error: err.message };
      }
      throw err;
    }
  }

  return {
    content,
    ...(userId ? { userId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(parseResult.data.visibility ? { visibility: parseResult.data.visibility } : {}),
    ...(parseResult.data.whisperTo ? { whisperTo: parseResult.data.whisperTo as string[] } : {}),
    ...(parseResult.data.deliveryMode ? { deliveryMode: parseResult.data.deliveryMode } : {}),
    ...(parseResult.data.messageDisposition ? { messageDisposition: parseResult.data.messageDisposition } : {}),
    ...(parseResult.data.replyTo ? { replyTo: parseResult.data.replyTo } : {}),
    contentBlocks: buildMessageContentBlocks(content, contextAttachments, uploadedContent),
  };
}
