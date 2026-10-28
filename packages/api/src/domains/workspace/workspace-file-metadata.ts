import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import sharp from 'sharp';
import { guessMime } from './workspace-file-read.js';

/** Shared MIME facts also drive opening and catalogue projections. */
export function workspaceReferenceMime(path: string): string {
  return guessMime(path);
}

/** Only OOXML's small producer metadata is inspected; no conversion, extraction or execution. */
async function officePages(path: string): Promise<{ pageCount?: number; pageUnit?: 'pages' | 'slides' | 'sheets' }> {
  const extension = extname(path).toLowerCase();
  if (!['.pptx', '.docx', '.xlsx'].includes(extension)) return {};
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 32 * 1024 * 1024 || info.size < 22) return {};
    const bytes = Buffer.alloc(info.size);
    if ((await file.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length) return {};
    // Read the central directory so data-descriptor archives do not require scanning/compressing full members.
    let eocd = bytes.length - 22;
    for (; eocd >= Math.max(0, bytes.length - 65557); eocd--) if (bytes.readUInt32LE(eocd) === 0x06054b50) break;
    if (eocd < Math.max(0, bytes.length - 65557)) return {};
    const count = bytes.readUInt16LE(eocd + 10);
    let offset = bytes.readUInt32LE(eocd + 16);
    for (let index = 0; index < Math.min(count, 10000) && offset + 46 <= bytes.length; index++) {
      if (bytes.readUInt32LE(offset) !== 0x02014b50) return {};
      const length = bytes.readUInt16LE(offset + 28),
        extra = bytes.readUInt16LE(offset + 30),
        comment = bytes.readUInt16LE(offset + 32);
      const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8');
      if (name === (extension === '.xlsx' ? 'xl/workbook.xml' : 'docProps/app.xml')) {
        const compressed = bytes.readUInt32LE(offset + 20),
          uncompressed = bytes.readUInt32LE(offset + 24),
          local = bytes.readUInt32LE(offset + 42);
        if (
          compressed > 65536 ||
          uncompressed > 65536 ||
          local + 30 > bytes.length ||
          bytes.readUInt32LE(local) !== 0x04034b50
        )
          return {};
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        if (start + compressed > bytes.length) return {};
        const method = bytes.readUInt16LE(offset + 10),
          content = bytes.subarray(start, start + compressed);
        const xml = (
          method === 8 ? inflateRawSync(content, { maxOutputLength: 65536 }) : method === 0 ? content : Buffer.alloc(0)
        ).toString('utf8');
        if (extension === '.xlsx') {
          const sheets = /<(?:\w+:)?sheets\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sheets>/.exec(xml)?.[1];
          return sheets !== undefined
            ? { pageCount: [...sheets.matchAll(/<(?:\w+:)?sheet\b/g)].length, pageUnit: 'sheets' }
            : {};
        }
        const tag = extension === '.pptx' ? 'Slides' : 'Pages';
        const value = tag ? new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`).exec(xml)?.[1] : undefined;
        return value && Number.isSafeInteger(Number(value))
          ? { pageCount: Number(value), pageUnit: extension === '.pptx' ? 'slides' : 'pages' }
          : {};
      }
      offset += 46 + length + extra + comment;
    }
    return {};
  } finally {
    await file.close();
  }
}

export async function readWorkspaceFileMetadata(path: string) {
  const info = await stat(path);
  const mime = info.isDirectory() ? 'inode/directory' : workspaceReferenceMime(path);
  return {
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    mime,
    ...(info.isFile() && mime.startsWith('image/') ? await imageDimensions(path).catch(() => ({})) : {}),
    ...(info.isFile() ? await officePages(path).catch(() => ({})) : {}),
  };
}

/** Read a bounded header through the same no-follow file boundary; never decode pixels. */
async function imageDimensions(path: string): Promise<{ width?: number; height?: number }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) return {};
    const header = Buffer.alloc(Math.min(info.size, 256 * 1024));
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const { width, height } = await sharp(header.subarray(0, bytesRead)).metadata();
    return width && height ? { width, height } : {};
  } finally {
    await file.close();
  }
}
