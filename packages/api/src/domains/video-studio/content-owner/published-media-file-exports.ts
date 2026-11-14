import { createHash, randomUUID } from 'node:crypto';
import { type FileHandle, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalMediaFileDigest } from './local-media-file-digest.js';
import { MAX_STREAM_CONTENT_BYTES } from './stream-content.js';

const extensions: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
};

const failureMessages = {
  unavailable: '无法准备可安全交给本机应用的作品副本。',
  unsupported: '此媒体类型不支持本机文件操作。',
  too_large: `作品超过本机文件操作支持的 ${MAX_STREAM_CONTENT_BYTES / 1024 ** 3} GiB 上限。`,
  busy: '暂时无法准备可安全交给本机应用的作品副本，请稍后重试。',
};

export class LocalMediaFileUnavailable extends Error {
  constructor(readonly reason: keyof typeof failureMessages = 'unavailable') {
    super(failureMessages[reason]);
    this.name = 'LocalMediaFileUnavailable';
  }
}

function localFileFailure(error: unknown) {
  if (error instanceof LocalMediaFileUnavailable) return error;
  const transient =
    error instanceof Error && 'code' in error && ['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE'].includes(String(error.code));
  return new LocalMediaFileUnavailable(transient ? 'busy' : 'unavailable');
}

export function mediaFileExtensionMatches(path: string, mime: string) {
  const extension = extensions[mime];
  return (
    !!extension &&
    (path.toLowerCase().endsWith(`.${extension}`) || (mime === 'image/jpeg' && path.toLowerCase().endsWith('.jpeg')))
  );
}

export function mediaExportFilename(title: string, mime: string): string {
  const extension = extensions[mime];
  if (!extension) throw new LocalMediaFileUnavailable('unsupported');
  let name = title
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}/\\:*?"<>|]/gu, '-')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  name = Array.from(name).slice(0, 100).join('');
  while (Buffer.byteLength(name) > 180) name = Array.from(name).slice(0, -1).join('');
  name = name.replace(/\.(?:mp4|png|jpe?g|webp|gif|svg)$/i, '') || '作品';
  return `${name}.${extension}`;
}

async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new LocalMediaFileUnavailable();
}

type Source = { handle: FileHandle; byteLength: number; blobDigest: string; mediaType: string };

/** Copy verified owner bytes, never link its inode. Exports are expendable; published bytes remain immutable. */
export class PublishedMediaFileExports {
  private readonly digests = new LocalMediaFileDigest();
  private readonly pending = new Map<string, Promise<string>>();
  constructor(private readonly directory: string) {}

  async materialize(source: Source, title: string): Promise<string> {
    if (source.byteLength > MAX_STREAM_CONTENT_BYTES) throw new LocalMediaFileUnavailable('too_large');
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 1) throw new LocalMediaFileUnavailable();
    const digest = /^sha256:([a-f0-9]{64})$/.exec(source.blobDigest)?.[1];
    if (!digest) throw new LocalMediaFileUnavailable();
    const name = mediaExportFilename(title, source.mediaType);
    const directory = join(this.directory, digest);
    const path = join(directory, name);
    const pending = this.pending.get(path);
    if (pending) return pending;
    const operation = this.copy(source, directory, path).catch((error: unknown) => {
      throw localFileFailure(error);
    });
    this.pending.set(path, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(path);
    }
  }

  private async copy(source: Source, directory: string, path: string) {
    await privateDirectory(this.directory);
    await privateDirectory(directory);
    if (await this.digests.matches(path, source.blobDigest, true)) return path;
    const temporary = join(directory, `.pending-${randomUUID()}`);
    const target = await open(temporary, 'wx', 0o600);
    try {
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let position = 0;
      while (position < source.byteLength) {
        const length = Math.min(buffer.length, source.byteLength - position);
        const { bytesRead } = await source.handle.read(buffer, 0, length, position);
        if (bytesRead === 0) throw new LocalMediaFileUnavailable();
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const step = await target.write(buffer, written, bytesRead - written, position + written);
          if (!step.bytesWritten) throw new LocalMediaFileUnavailable();
          written += step.bytesWritten;
        }
        position += bytesRead;
      }
      if (`sha256:${hash.digest('hex')}` !== source.blobDigest) throw new LocalMediaFileUnavailable();
      await target.chmod(0o444);
      await target.sync();
      const [written, named] = await Promise.all([target.stat(), lstat(temporary)]);
      // The streamed hash proves the bytes. Verify the private inode before publishing it,
      // so no failed validation can leave a final-name copy or trigger another full-file read.
      if (
        !written.isFile() ||
        written.size !== source.byteLength ||
        written.nlink !== 1 ||
        (written.mode & 0o222) !== 0 ||
        named.isSymbolicLink() ||
        named.dev !== written.dev ||
        named.ino !== written.ino
      )
        throw new LocalMediaFileUnavailable();
      await target.close();
      await rename(temporary, path);
      return path;
    } finally {
      await target.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
}
