import { lookup } from 'node:dns/promises';
import type { IncomingMessage, RequestOptions } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const NON_PUBLIC_IPV4_RANGES: readonly [number, number][] = [
  [0x00000000, 0xff000000], // 0.0.0.0/8 "this network"
  [0x0a000000, 0xff000000], // 10.0.0.0/8 private
  [0x64400000, 0xffc00000], // 100.64.0.0/10 carrier-grade NAT
  [0x7f000000, 0xff000000], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 link-local
  [0xac100000, 0xfff00000], // 172.16.0.0/12 private
  [0xc0000000, 0xffffff00], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 0xffffff00], // 192.0.2.0/24 documentation
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16 private
  [0xc6120000, 0xfffe0000], // 198.18.0.0/15 benchmark tests
  [0xc6336400, 0xffffff00], // 198.51.100.0/24 documentation
  [0xcb007100, 0xffffff00], // 203.0.113.0/24 documentation
  [0xe0000000, 0xf0000000], // 224.0.0.0/4 multicast
  [0xf0000000, 0xf0000000], // 240.0.0.0/4 reserved
] as const;

const NON_PUBLIC_IPV6_RANGES = [
  /^::1$/,
  /^::$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]?:/i,
  /^fe[cdef][0-9a-f]?:/i,
  /^ff/i,
  /^2001:db8:/i,
];

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata.internal']);

export type DnsLookup = (hostname: string) => Promise<readonly { readonly address: string }[]>;

export interface ResolvedExternalUrl {
  readonly url: URL;
  readonly address: string;
  readonly hostname: string;
}

export interface PinnedFetchOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly dnsLookup?: DnsLookup;
}

export interface PinnedFetchResult {
  readonly contentType: string;
  readonly body: Buffer;
}

export type PinnedRequestOptions = RequestOptions & { servername?: string };

function normalizeHostname(hostname: string): string {
  let h = hostname.toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  h = h.replace(/^\[|\]$/g, '');
  const v4mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return v4mapped[1]!;
  const v4hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4hex) {
    const hi = parseInt(v4hex[1]!, 16);
    const lo = parseInt(v4hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return h;
}

function parseIpv4(hostname: string): number | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value >>> 0;
}

function isPublicIpv4(hostname: string): boolean {
  const value = parseIpv4(hostname);
  if (value === null) return false;
  return !NON_PUBLIC_IPV4_RANGES.some(([network, mask]) => (value & mask) >>> 0 === network);
}

function isPublicIpv6(hostname: string): boolean {
  return !NON_PUBLIC_IPV6_RANGES.some((pattern) => pattern.test(hostname));
}

function assertExternalHostnameAllowed(hostname: string): string {
  const normalized = normalizeHostname(hostname);
  if (BLOCKED_HOSTNAMES.has(normalized)) {
    throw new Error(`URL hostname is blocked: ${normalized}`);
  }

  const ipType = isIP(normalized);
  if (ipType === 4) {
    if (!isPublicIpv4(normalized)) {
      throw new Error(`URL resolves to private/reserved IP range: ${normalized}`);
    }
  } else if (ipType === 6) {
    if (!isPublicIpv6(normalized)) {
      throw new Error(`URL resolves to private/reserved IP range: ${normalized}`);
    }
  }

  return normalized;
}

async function defaultDnsLookup(hostname: string): Promise<readonly { readonly address: string }[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

export function validateExternalUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`URL must use http or https protocol: ${url}`);
  }

  assertExternalHostnameAllowed(parsed.hostname);
  return parsed;
}

export async function resolveExternalUrl(
  url: string,
  dnsLookup: DnsLookup = defaultDnsLookup,
): Promise<ResolvedExternalUrl> {
  const parsed = validateExternalUrl(url);
  const hostname = normalizeHostname(parsed.hostname);
  if (isIP(hostname)) return { url: parsed, address: hostname, hostname };

  let records: readonly { readonly address: string }[];
  try {
    records = await dnsLookup(hostname);
  } catch {
    throw new Error(`URL hostname could not be resolved: ${hostname}`);
  }

  if (records.length === 0) {
    throw new Error(`URL hostname could not be resolved: ${hostname}`);
  }

  for (const record of records) {
    assertExternalHostnameAllowed(record.address);
  }

  const firstRecord = records[0];
  if (!firstRecord) {
    throw new Error(`URL hostname could not be resolved: ${hostname}`);
  }
  return { url: parsed, address: firstRecord.address, hostname };
}

export async function validateExternalUrlResolved(url: string, dnsLookup: DnsLookup = defaultDnsLookup): Promise<void> {
  await resolveExternalUrl(url, dnsLookup);
}

export function createPinnedRequestOptions(resolved: ResolvedExternalUrl): PinnedRequestOptions {
  const options: PinnedRequestOptions = {
    protocol: resolved.url.protocol,
    hostname: resolved.address,
    path: `${resolved.url.pathname}${resolved.url.search}`,
    method: 'GET',
    headers: { Host: resolved.url.host },
  };

  if (resolved.url.port) options.port = Number(resolved.url.port);
  if (resolved.url.protocol === 'https:') options.servername = resolved.hostname;
  return options;
}

function collectPinnedResponse(res: IncomingMessage, maxBytes: number): Promise<PinnedFetchResult> {
  return new Promise((resolve, reject) => {
    const statusCode = res.statusCode ?? 0;
    if (statusCode >= 300 && statusCode < 400) {
      res.resume();
      reject(new Error('External image redirects are not allowed'));
      return;
    }
    if (statusCode < 200 || statusCode >= 300) {
      res.resume();
      reject(new Error(`External image fetch failed with HTTP ${statusCode}`));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error(`Image exceeds ${maxBytes} bytes limit`));
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      resolve({
        contentType: Array.isArray(res.headers['content-type'])
          ? (res.headers['content-type'][0] ?? '')
          : (res.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks),
      });
    });
    res.on('error', reject);
  });
}

export async function fetchExternalUrlPinned(url: string, options: PinnedFetchOptions): Promise<PinnedFetchResult> {
  const resolved = await resolveExternalUrl(url, options.dnsLookup ?? defaultDnsLookup);
  const requestOptions = createPinnedRequestOptions(resolved);
  const client = resolved.url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(requestOptions, (res) => {
      collectPinnedResponse(res, options.maxBytes).then(resolve, reject);
    });
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(`External image fetch timed out after ${options.timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}
