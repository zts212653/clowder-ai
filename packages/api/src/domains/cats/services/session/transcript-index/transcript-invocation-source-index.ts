import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { normalizeTranscriptEvent } from '../TranscriptEventEnvelope.js';
import type { TranscriptEvent } from '../TranscriptReader.js';
import { compactTranscriptEvent } from './transcript-invocation-compact-event.js';
import type { InvocationIndexDiagnostics } from './transcript-invocation-index-types.js';

interface SourceCheckpoint {
  signature: string;
  inode: string;
  size: number;
  next_offset: number;
  head_hash: string;
  tail_hash: string;
}

export interface IndexedSource {
  file: FileHandle | null;
  signature: string;
}

async function boundaryHash(file: FileHandle, start: number, end: number): Promise<string> {
  const bytes = Buffer.alloc(end - start);
  const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
  return createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex');
}

/** Keeps at most one JSONL record in memory; offsets are bytes, including CRLF. */
async function* lines(file: FileHandle, start: number, end: number) {
  if (start >= end) return;
  let pieces: Buffer[] = [];
  let length = 0;
  let offset = start;
  for (let position = start; position < end; ) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - position));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const bytes = chunk.subarray(0, bytesRead);
    let from = 0;
    for (let newline = bytes.indexOf(10, from); newline >= 0; newline = bytes.indexOf(10, from)) {
      const part = bytes.subarray(from, newline);
      pieces.push(part);
      length += part.length;
      yield { bytes: Buffer.concat(pieces, length), offset, length: length + 1, complete: true };
      offset += length + 1;
      pieces = [];
      length = 0;
      from = newline + 1;
    }
    if (from < bytes.length) {
      pieces.push(bytes.subarray(from));
      length += bytes.length - from;
    }
  }
  if (length > 0) yield { bytes: Buffer.concat(pieces, length), offset, length, complete: false };
}

async function isAppend(
  file: FileHandle,
  previous: SourceCheckpoint,
  source: number,
  inode: string,
  size: number,
): Promise<boolean> {
  if (source !== 1 || previous.inode !== inode || size <= previous.size) return false;
  const end = previous.next_offset;
  return (
    previous.head_hash === (await boundaryHash(file, 0, Math.min(end, 4096))) &&
    previous.tail_hash === (await boundaryHash(file, Math.max(0, end - 4096), end))
  );
}

/** Caller owns the index transaction. Source JSONL files are never modified. */
export async function updateTranscriptSourceIndex(
  db: Database.Database,
  source: number,
  path: string,
  diagnostics: InvocationIndexDiagnostics,
): Promise<IndexedSource> {
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    db.prepare('DELETE FROM source_events WHERE source = ?').run(source);
    db.prepare('DELETE FROM sources WHERE source = ?').run(source);
    return { file: null, signature: 'missing' };
  }
  try {
    const stat = await file.stat({ bigint: true });
    const size = Number(stat.size);
    const inode = `${stat.dev}:${stat.ino}`;
    const signature = `${inode}:${size}:${stat.mtimeNs}`;
    const previous = db.prepare('SELECT * FROM sources WHERE source = ?').get(source) as SourceCheckpoint | undefined;
    if (previous?.signature === signature) return { file, signature };
    const start = previous && (await isAppend(file, previous, source, inode, size)) ? previous.next_offset : 0;
    db.prepare('DELETE FROM source_events WHERE source = ? AND byte_offset >= ?').run(source, start);
    let seq = (
      db.prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM source_events WHERE source = ?').get(source) as {
        next: number;
      }
    ).next;
    const insert = db.prepare(`INSERT INTO source_events
      (source, seq, event_no, invocation_id, hash, byte_offset, byte_length, projection, files_touched)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let nextOffset = start;
    for await (const line of lines(file, start, size)) {
      diagnostics.sourceBytesScanned += line.length;
      if (line.complete) nextOffset = line.offset + line.length;
      let event: TranscriptEvent | undefined;
      try {
        event = normalizeTranscriptEvent(JSON.parse(line.bytes.toString('utf8')));
      } catch {
        continue;
      }
      if (!event) continue;
      const compact = compactTranscriptEvent(event);
      insert.run(
        source,
        seq++,
        event.eventNo,
        event.invocationId ?? null,
        compact.hash,
        line.offset,
        line.length,
        JSON.stringify(compact.projection),
        JSON.stringify(compact.filesTouched),
      );
    }
    if ((await file.stat()).size < size) throw new Error('Transcript was truncated while indexing');
    db.prepare(`INSERT OR REPLACE INTO sources
      (source, signature, inode, size, next_offset, head_hash, tail_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      source,
      signature,
      inode,
      size,
      nextOffset,
      await boundaryHash(file, 0, Math.min(nextOffset, 4096)),
      await boundaryHash(file, Math.max(0, nextOffset - 4096), nextOffset),
    );
    return { file, signature };
  } catch (error) {
    await file.close();
    throw error;
  }
}
