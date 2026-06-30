import { lookup } from 'node:dns/promises';
import type { IncomingMessage, RequestOptions } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

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

const IPV6_FULL_MASK = (1n << 128n) - 1n;

const NON_PUBLIC_IPV6_CIDRS = [
  '::/128', // unspecified
  '::1/128', // loopback
  '::/96', // deprecated IPv4-compatible addresses
  '::ffff:0:0/96', // IPv4-mapped addresses
  '::ffff:0:0:0/96', // IPv4-translated addresses
  '64:ff9b::/96', // IPv4/IPv6 translation
  '64:ff9b:1::/48', // local-use IPv4/IPv6 translation
  '100::/64', // discard-only
  '2001::/23', // IETF protocol assignments
  '2001:2::/48', // benchmark tests
  '2001:db8::/32', // documentation
  '2001:10::/28', // deprecated ORCHID
  '2001:20::/28', // ORCHIDv2
  '2002::/16', // 6to4
  '3fff::/20', // documentation
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'fec0::/10', // deprecated site-local
  'ff00::/8', // multicast
] as const;

const NON_PUBLIC_IPV6_RANGES = NON_PUBLIC_IPV6_CIDRS.map((cidr) => {
  const [address, prefixRaw] = cidr.split('/');
  const prefixLength = Number(prefixRaw);
  const network = parseIpv6(address ?? '');
  if (network === null || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) {
    throw new Error(`Invalid IPv6 CIDR: ${cidr}`);
  }
  return { network, prefixLength };
});

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

function parseIpv6Part(part: string): number[] | null {
  if (part.length === 0) return [];
  const values: number[] = [];
  for (const segment of part.split(':')) {
    if (segment.length === 0) return null;
    if (segment.includes('.')) {
      const v4 = parseIpv4(segment);
      if (v4 === null) return null;
      values.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) return null;
    values.push(parseInt(segment, 16));
  }
  return values;
}

function parseIpv6(hostname: string): bigint | null {
  const [address] = hostname.toLowerCase().split('%', 1);
  if (!address || address.includes(':::')) return null;
  const compressed = address.split('::');
  if (compressed.length > 2) return null;

  const left = parseIpv6Part(compressed[0] ?? '');
  const right = parseIpv6Part(compressed.length === 2 ? (compressed[1] ?? '') : '');
  if (!left || !right) return null;

  const missing = 8 - left.length - right.length;
  if (compressed.length === 1) {
    if (missing !== 0) return null;
  } else if (missing < 0) {
    return null;
  }

  const groups = compressed.length === 1 ? left : [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (groups.length !== 8) return null;

  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function ipv6Mask(prefixLength: number): bigint {
  if (prefixLength === 0) return 0n;
  return (IPV6_FULL_MASK << BigInt(128 - prefixLength)) & IPV6_FULL_MASK;
}

function matchesIpv6Range(address: bigint, network: bigint, prefixLength: number): boolean {
  const mask = ipv6Mask(prefixLength);
  return (address & mask) === (network & mask);
}

function isPublicIpv6(hostname: string): boolean {
  const address = parseIpv6(hostname);
  if (address === null) return false;
  return !NON_PUBLIC_IPV6_RANGES.some(({ network, prefixLength }) => matchesIpv6Range(address, network, prefixLength));
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

function createPinnedFetchTimeoutError(timeoutMs: number): Error {
  return new Error(`External image fetch timed out after ${timeoutMs}ms`);
}

async function resolveExternalUrlWithinTimeout(
  url: string,
  dnsLookup: DnsLookup,
  timeoutMs: number,
): Promise<ResolvedExternalUrl> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolveExternalUrl(url, dnsLookup),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(createPinnedFetchTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const startedAt = performance.now();
  const timeoutError = () => createPinnedFetchTimeoutError(options.timeoutMs);
  const resolved = await resolveExternalUrlWithinTimeout(url, options.dnsLookup ?? defaultDnsLookup, options.timeoutMs);
  const remainingTimeoutMs = Math.ceil(options.timeoutMs - (performance.now() - startedAt));
  if (remainingTimeoutMs <= 0) throw timeoutError();

  const requestOptions = createPinnedRequestOptions(resolved);
  const client = resolved.url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = <T>(fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const req = client.request(requestOptions, (res) => {
      collectPinnedResponse(res, options.maxBytes).then(
        (result) => settle(resolve, result),
        (err) => settle(reject, err),
      );
    });
    timer = setTimeout(() => {
      const err = timeoutError();
      req.destroy(err);
      settle(reject, err);
    }, remainingTimeoutMs);
    req.setTimeout(remainingTimeoutMs, () => {
      const err = timeoutError();
      req.destroy(err);
      settle(reject, err);
    });
    req.on('error', (err) => settle(reject, err));
    req.end();
  });
}
