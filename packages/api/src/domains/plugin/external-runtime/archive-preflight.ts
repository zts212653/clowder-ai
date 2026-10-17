import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { ExternalPluginRuntimeError } from './types.js';

// Source-neutral security ceilings, counting raw members (including AppleDouble),
// not just the platform tar listing. Directory closure readiness is a separate gate.
export const PLUGIN_ARCHIVE_BUDGET = Object.freeze({
  compressedBytes: 32 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  // Bundled native CLIs can exceed 32MiB; the whole package still shares 64MiB.
  singleFileBytes: 64 * 1024 * 1024,
  regularFiles: 16_384,
  headers: 32_768,
  streamBytes: 96 * 1024 * 1024,
  metadataBytes: 4 * 1024 * 1024,
  metadataRecordBytes: 64 * 1024,
  pathBytes: 4096,
  pathDepth: 64,
  deadlineMs: 30_000,
});

function invalid(detail: string): never {
  throw new ExternalPluginRuntimeError('PACKAGE_AUTHORITY_MISMATCH', `archive preflight limit: ${detail}`);
}

const decoder = new TextDecoder('utf-8', { fatal: true });
function text(bytes: Buffer): string {
  try {
    return decoder.decode(bytes);
  } catch {
    invalid('invalid UTF-8 text field');
  }
}
function field(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some((byte) => byte !== 0)) invalid('ambiguous string field');
  return text(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(bytes: Buffer): number {
  const value = bytes.toString('ascii').replace(/\0.*$/s, '').trim();
  // Reject GNU base-256 and invalid/negative sizes rather than approximating them.
  if (
    bytes.some((byte) => byte > 127) ||
    !/^[0-7]*$/.test(value) ||
    !/^[0-7 ]*(?:\0[\0 ]*)?$/.test(bytes.toString('ascii'))
  )
    invalid('unsupported numeric encoding');
  const number = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(number)) invalid('unsafe numeric field');
  return number;
}
function pathBudget(value: string): void {
  if (Buffer.byteLength(value) > PLUGIN_ARCHIVE_BUDGET.pathBytes) invalid('path byte budget exceeded');
  if (value.split('/').length > PLUGIN_ARCHIVE_BUDGET.pathDepth) invalid('path depth budget exceeded');
  if (
    !value ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').includes('..')
  ) {
    invalid('unsafe member path');
  }
}

const inertPaxKeys = new Set([
  'mtime',
  'atime',
  'ctime',
  'uid',
  'gid',
  'uname',
  'gname',
  'comment',
  'LIBARCHIVE.xattr.com.apple.provenance',
  'SCHILY.xattr.com.apple.provenance',
]);
function paxRecord(bytes: Buffer, offset: number): { key: string; value: Buffer; end: number } {
  const space = bytes.indexOf(32, offset);
  if (space < 0) invalid('malformed PAX length');
  const digits = bytes.toString('ascii', offset, space);
  if (!/^[1-9][0-9]*$/.test(digits)) invalid('malformed PAX length');
  const length = Number(digits);
  const end = offset + length;
  if (!Number.isSafeInteger(length) || end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) {
    invalid('malformed PAX record');
  }
  const entry = bytes.subarray(space + 1, end - 1);
  const equal = entry.indexOf(61);
  if (equal <= 0) invalid('malformed PAX key');
  return { key: text(entry.subarray(0, equal)), value: entry.subarray(equal + 1), end };
}
const binaryPaxKeys = new Set(['SCHILY.xattr.com.apple.provenance', 'LIBARCHIVE.xattr.com.apple.provenance']);
function parsePax(bytes: Buffer, global: boolean): Map<string, string> {
  const values = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const { key, value: rawValue, end } = paxRecord(bytes, offset);
    if (values.has(key)) invalid('duplicate PAX key');
    if (!inertPaxKeys.has(key) && (global || (key !== 'path' && key !== 'size'))) {
      invalid('unsupported PAX extension'); // Includes sparse maps, links and alternate path encodings.
    }
    // SCHILY xattrs carry binary values; decode only text-bearing keys. All bytes
    // still count toward record/aggregate/stream budgets. These keys cannot override size/path.
    const value = binaryPaxKeys.has(key) ? '' : text(rawValue);
    if (key === 'path') pathBudget(value);
    if (key === 'size' && (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
      invalid('invalid PAX size');
    }
    values.set(key, value);
    offset = end;
  }
  return values;
}

function readHeader(bytes: Buffer): { name: string; type: string; size: number } {
  const expected = octal(bytes.subarray(148, 156));
  let checksum = 0;
  for (const [i, byte] of bytes.entries()) checksum += i >= 148 && i < 156 ? 32 : byte;
  if (checksum !== expected) invalid('header checksum mismatch');
  const magic = bytes.toString('ascii', 257, 263);
  if (magic !== 'ustar\0' && magic !== 'ustar ') invalid('unsupported tar format');
  const prefix = field(bytes.subarray(345, 500));
  const base = field(bytes.subarray(0, 100));
  const name = prefix ? `${prefix}/${base}` : base;
  pathBudget(name);
  return { name, type: String.fromCharCode(bytes.readUInt8(156)), size: octal(bytes.subarray(124, 136)) };
}

class TarBudgetReader {
  private buffered = Buffer.alloc(0);
  private remaining = 0;
  private padding = 0;
  private metadataType = '';
  private metadataParts: Buffer[] = [];
  private pendingPax: Map<string, string> | undefined;
  private pendingLongPath: string | undefined;
  private zeroBlocks = 0;
  private totalStream = 0;
  private totalHeaders = 0;
  private totalMetadata = 0;
  private totalFiles = 0;
  private totalBytes = 0;

  accept(chunk: Buffer): void {
    this.totalStream += chunk.length;
    if (this.totalStream > PLUGIN_ARCHIVE_BUDGET.streamBytes) invalid('expanded stream work budget exceeded');
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length) {
      if (this.remaining) {
        this.consumeBody();
      } else if (this.padding) {
        const consumed = Math.min(this.padding, this.buffered.length);
        if (this.buffered.subarray(0, consumed).some((byte) => byte !== 0)) invalid('nonzero member padding');
        this.buffered = this.buffered.subarray(consumed);
        this.padding -= consumed;
      } else {
        if (this.buffered.length < 512) return;
        const header = this.buffered.subarray(0, 512);
        this.buffered = this.buffered.subarray(512);
        this.header(header);
      }
    }
  }

  private consumeBody(): void {
    const consumed = Math.min(this.remaining, this.buffered.length);
    if (this.metadataType) this.metadataParts.push(Buffer.from(this.buffered.subarray(0, consumed)));
    this.buffered = this.buffered.subarray(consumed);
    this.remaining -= consumed;
    if (!this.remaining && this.metadataType) this.finishMetadata();
  }

  private finishMetadata(): void {
    const bytes = Buffer.concat(this.metadataParts);
    if (this.metadataType === 'L') {
      if (this.pendingLongPath || this.pendingPax) invalid('ambiguous stacked path extensions');
      this.pendingLongPath = field(bytes);
      pathBudget(this.pendingLongPath);
    } else {
      const values = parsePax(bytes, this.metadataType === 'g');
      if (this.metadataType === 'x') {
        if (this.pendingPax || this.pendingLongPath) invalid('ambiguous stacked PAX extensions');
        this.pendingPax = values;
      }
    }
    this.metadataParts = [];
    this.metadataType = '';
  }

  private header(bytes: Buffer): void {
    if (bytes.every((byte) => byte === 0)) {
      this.zeroBlocks += 1;
      return;
    }
    if (this.zeroBlocks) invalid('nonzero data after archive terminator');
    if (++this.totalHeaders > PLUGIN_ARCHIVE_BUDGET.headers) invalid('header count budget exceeded');
    const { name, type, size } = readHeader(bytes);
    if (type === 'x' || type === 'g' || type === 'L') {
      this.beginMetadata(type, size);
      return;
    }
    this.beginMember(name, type, size);
  }

  private beginMetadata(type: string, size: number): void {
    this.totalMetadata += size;
    if (
      !size ||
      size > PLUGIN_ARCHIVE_BUDGET.metadataRecordBytes ||
      this.totalMetadata > PLUGIN_ARCHIVE_BUDGET.metadataBytes
    ) {
      invalid('metadata budget exceeded');
    }
    this.metadataType = type;
    this.remaining = size;
    this.padding = (512 - (size % 512)) % 512;
  }

  private beginMember(name: string, type: string, size: number): void {
    if (type !== '0' && type !== '\0' && type !== '5') invalid('link or special member');
    const effectivePath = this.pendingLongPath ?? this.pendingPax?.get('path') ?? name;
    const effectiveSize = this.pendingPax?.has('size') ? Number(this.pendingPax.get('size')) : size;
    pathBudget(effectivePath);
    this.pendingLongPath = undefined;
    this.pendingPax = undefined;
    if (effectiveSize > PLUGIN_ARCHIVE_BUDGET.singleFileBytes || size > PLUGIN_ARCHIVE_BUDGET.singleFileBytes) {
      invalid('single-file budget exceeded');
    }
    if (type === '5') {
      if (size !== 0 || effectiveSize !== 0) invalid('directory with payload');
    } else {
      if (++this.totalFiles > PLUGIN_ARCHIVE_BUDGET.regularFiles) invalid('regular-file count budget exceeded');
      this.totalBytes += effectiveSize;
      if (this.totalBytes > PLUGIN_ARCHIVE_BUDGET.expandedBytes) invalid('expanded member budget exceeded');
    }
    this.remaining = effectiveSize;
    this.padding = (512 - (effectiveSize % 512)) % 512;
  }

  finish(): void {
    if (
      this.remaining ||
      this.padding ||
      this.buffered.length ||
      this.zeroBlocks < 2 ||
      this.pendingPax ||
      this.pendingLongPath
    ) {
      invalid('truncated archive or dangling extension');
    }
  }
}

/** Resource validation on the sealed archive, before invoking platform tar at all. */
export async function preflightPluginArchive(archivePath: string, signal?: AbortSignal): Promise<void> {
  if ((await stat(archivePath)).size > PLUGIN_ARCHIVE_BUDGET.compressedBytes)
    invalid('compressed byte budget exceeded');
  const reader = new TarBudgetReader();
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        reader.accept(chunk);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      try {
        reader.finish();
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  const deadline = AbortSignal.timeout(PLUGIN_ARCHIVE_BUDGET.deadlineMs);
  await pipeline(createReadStream(archivePath), createGunzip(), sink, {
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
}
