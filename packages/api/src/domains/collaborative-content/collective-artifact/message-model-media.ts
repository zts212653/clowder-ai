import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import {
  type CollectiveContextAttachmentSelection,
  type CollectiveMessageAttachment,
  type CollectiveModelMedia,
  collectiveModelMediaSchema,
} from '@cat-cafe/shared';
import { type CollectiveAudioTranscriber, readModelAv } from './message-model-av.js';
import { withModelMediaFile } from './message-model-media-file.js';

const textExtensions = new Set([
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.css',
  '.html',
  '.xml',
  '.yaml',
  '.yml',
  '.log',
  '.sql',
  '.sh',
  '.ini',
  '.svg',
]);
export async function readCollectiveModelMedia(
  attachment: CollectiveMessageAttachment,
  body: Readable,
  authorize: () => Promise<void>,
  signal: AbortSignal,
  selection: CollectiveContextAttachmentSelection,
  transcribe?: CollectiveAudioTranscriber,
): Promise<CollectiveModelMedia> {
  return withModelMediaFile(attachment, body, authorize, signal, async (path, directory) => {
    let content: CollectiveModelMedia['content'];
    if (attachment.mediaType.startsWith('audio/') || attachment.mediaType.startsWith('video/'))
      content = await readModelAv(attachment, path, directory, selection, signal, transcribe);
    else if (
      attachment.mediaType.startsWith('text/') ||
      textExtensions.has(extname(attachment.fileName).toLowerCase()) ||
      ['application/json', 'application/xml', 'application/javascript'].includes(attachment.mediaType)
    ) {
      const bytes = await readFile(path);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\u0000')) throw new Error('This attachment is not a supported UTF-8 text file');
      const offset = selection.textOffset ?? 0;
      if (
        offset > text.length ||
        (offset > 0 && /[\uDC00-\uDFFF]/u.test(text[offset] ?? '') && /[\uD800-\uDBFF]/u.test(text[offset - 1] ?? ''))
      )
        throw new Error('Use the text reader nextOffset to continue this file');
      let end = Math.min(text.length, offset + 64_000);
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end--;
      content = {
        type: 'text',
        text: text.slice(offset, end),
        encoding: 'utf-8',
        offset,
        ...(end < text.length ? { nextOffset: end } : {}),
        totalCharacters: text.length,
        truncated: offset > 0 || end < text.length,
      };
    } else content = { type: 'unavailable', reason: 'unsupported_format' };
    await authorize();
    signal.throwIfAborted();
    return collectiveModelMediaSchema.parse({
      kind: 'collective_model_media',
      v: 1,
      attachmentId: attachment.attachmentId,
      sourceDigest: attachment.blobDigest,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      content,
    });
  });
}
