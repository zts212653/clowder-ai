import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { CollectiveMessageAttachment } from '@cat-cafe/shared';

/** A read-only derivative uses private scratch; original references/bytes remain with their existing owner. */
export async function withModelMediaFile<T>(
  attachment: CollectiveMessageAttachment,
  body: Readable,
  authorize: () => Promise<void>,
  signal: AbortSignal,
  work: (path: string, directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'cafe-public-model-media-'));
  try {
    const path = join(directory, 'original');
    const file = await open(path, 'wx', 0o600);
    try {
      let size = 0;
      const hash = createHash('sha256');
      for await (const chunk of body) {
        signal.throwIfAborted();
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > attachment.byteLength) throw new Error('Attachment length changed');
        hash.update(bytes);
        await file.writeFile(bytes);
      }
      if (size !== attachment.byteLength || `sha256:${hash.digest('hex')}` !== attachment.blobDigest)
        throw new Error('Attachment bytes changed');
    } finally {
      await file.close();
    }
    await authorize();
    signal.throwIfAborted();
    const result = await work(path, directory);
    await authorize();
    signal.throwIfAborted();
    return result;
  } finally {
    body.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}

/** The decoder inherits only the selected file descriptor. No file/HTTP/playlist protocol is admitted. */
export async function runModelMediaTool(
  binary: 'ffmpeg' | 'ffprobe',
  path: string,
  args: readonly string[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<Buffer> {
  signal.throwIfAborted();
  const file = await open(path, 'r');
  try {
    signal.throwIfAborted();
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(binary, ['-v', 'error', '-max_alloc', '67108864', ...args], {
        stdio: ['ignore', 'pipe', 'pipe', file.fd],
      });
      const chunks: Buffer[] = [];
      let size = 0,
        failure: Error | undefined;
      const abort = () => {
        failure = new Error('Published media processing was cancelled');
        child.kill('SIGKILL');
      };
      signal.addEventListener('abort', abort, { once: true });
      if (!child.stdout || !child.stderr) {
        failure = new Error('The local media decoder transport is unavailable');
        child.kill('SIGKILL');
      } else {
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            failure = new Error('Published media exceeds the model processing budget');
            child.kill('SIGKILL');
          } else if (!failure) chunks.push(chunk);
        });
        child.stderr.resume();
      }
      child.once('error', () => {
        failure = new Error('The local media decoder is unavailable');
      });
      child.once('close', (code) => {
        signal.removeEventListener('abort', abort);
        if (failure || code !== 0) reject(failure ?? new Error('Published media could not be decoded'));
        else resolve(Buffer.concat(chunks, size));
      });
      if (signal.aborted) abort();
    });
  } finally {
    await file.close();
  }
}

export function modelMediaInput(format: string, startSeconds?: number) {
  return [
    '-protocol_whitelist',
    'fd,pipe',
    '-f',
    format,
    '-fd',
    '3',
    ...(startSeconds === undefined ? [] : ['-ss', String(startSeconds)]),
    '-i',
    'fd:',
  ];
}
