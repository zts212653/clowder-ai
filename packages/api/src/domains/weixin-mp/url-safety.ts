import { lookup } from 'node:dns/promises';
import type { IncomingMessage, RequestOptions } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
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

function assertExternalHostnameAllowed(hostname: string): string {
  const normalized = normalizeHostname(hostname);
  if (BLOCKED_HOSTNAMES.has(normalized)) {
    throw new Error(`URL hostname is blocked: ${normalized}`);
  }

  for (const pattern of PRIVATE_IP_RANGES) {
    if (pattern.test(normalized)) {
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
