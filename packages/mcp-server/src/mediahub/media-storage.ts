/**
 * MediaHub — Media Storage
 * F139: Downloads generated media to local filesystem.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_OUTPUT_DIR = 'data/mediahub/outputs';
const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 min
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const BLOCKED_HOSTNAMES = new Set(['localhost', '[::1]']);

/** Check if an IPv4 address falls in a private/reserved range */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  return (
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8 private
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    a === 0 // 0.0.0.0/8
  );
}

/**
 * Extract the embedded IPv4 from an IPv4-mapped IPv6 address.
 * Handles both dotted (::ffff:127.0.0.1) and hex (::ffff:7f00:1) forms.
 */
function extractMappedIPv4(ipv6: string): string | null {
  const lower = ipv6.toLowerCase();
  // Dotted form: ::ffff:A.B.C.D
  const dottedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dottedMatch) return dottedMatch[1];
  // Hex form: ::ffff:HHHH:HHHH
  const hexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch) {
    const hi = Number.parseInt(hexMatch[1], 16);
    const lo = Number.parseInt(hexMatch[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** Block private/internal network targets to prevent SSRF */
function assertPublicHost(hostname: string): void {
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new Error(`Blocked download: host "${hostname}" is internal`);
  }
  // Strip brackets from IPv6
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === '::1' || bare.startsWith('fc') || bare.startsWith('fd') || bare.startsWith('fe80')) {
    throw new Error(`Blocked download: host "${hostname}" is internal`);
  }
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  const mapped = extractMappedIPv4(bare);
  if (mapped && isPrivateIPv4(mapped)) {
    throw new Error(`Blocked download: host "${hostname}" is internal`);
  }
  if (isPrivateIPv4(bare)) {
    throw new Error(`Blocked download: host "${bare}" is internal`);
  }
}

export class MediaStorage {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.resolve(process.cwd(), DEFAULT_OUTPUT_DIR);
  }

  private ensureJobDir(providerId: string, jobId: string): string {
    const dir = path.join(this.baseDir, providerId, jobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Download a media file from URL and save locally. Returns local file path. */
  async download(providerId: string, jobId: string, url: string, filename?: string): Promise<string> {
    // Validate URL protocol and host to prevent SSRF
    const parsed = new URL(url);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(`Blocked download: protocol "${parsed.protocol}" not allowed`);
    }
    assertPublicHost(parsed.hostname);

    const dir = this.ensureJobDir(providerId, jobId);
    const ext = this.guessExtension(url, filename);
    const outFile = filename ?? `output${ext}`;
    const filePath = path.join(dir, outFile);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Download failed (${response.status}): ${url}`);
      }
      if (!response.body) {
        throw new Error('Download returned empty body');
      }

      // Check Content-Length if available
      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Download too large: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_BYTES} limit`);
      }

      // Stream to disk with byte counting
      let bytesWritten = 0;
      const webStream = response.body;
      const nodeStream = Readable.fromWeb(webStream as never);
      const writeStream = fs.createWriteStream(filePath);

      const countingStream = new Readable({
        read() {},
      });

      nodeStream.on('data', (chunk: Buffer) => {
        bytesWritten += chunk.length;
        if (bytesWritten > MAX_DOWNLOAD_BYTES) {
          nodeStream.destroy(new Error(`Download exceeded ${MAX_DOWNLOAD_BYTES} byte limit`));
          return;
        }
        countingStream.push(chunk);
      });
      nodeStream.on('end', () => countingStream.push(null));
      nodeStream.on('error', (err) => countingStream.destroy(err));

      await pipeline(countingStream, writeStream);
      return filePath;
    } finally {
      clearTimeout(timer);
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  private guessExtension(url: string, filename?: string): string {
    if (filename) {
      const ext = path.extname(filename);
      if (ext) return ext;
    }
    try {
      const urlPath = new URL(url).pathname;
      const ext = path.extname(urlPath);
      if (ext && ext.length <= 5) return ext;
    } catch {
      // ignore URL parse errors
    }
    return '.mp4';
  }
}
