import { lookup } from 'node:dns/promises';
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

export async function validateExternalUrlResolved(url: string, dnsLookup: DnsLookup = defaultDnsLookup): Promise<void> {
  const parsed = validateExternalUrl(url);
  const hostname = normalizeHostname(parsed.hostname);
  if (isIP(hostname)) return;

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
}

export function safeFetchOptions(): { redirect: 'error' } {
  return { redirect: 'error' };
}
