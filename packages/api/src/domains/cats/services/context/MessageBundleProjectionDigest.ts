import { createHash } from 'node:crypto';
import {
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN_V2,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN_V2,
  MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN_V3,
  MESSAGE_BUNDLE_RICH_BLOCK_DIGEST_DOMAIN,
  type RichBlock,
} from '@cat-cafe/shared';

function digest(domain: string, projection: string): string {
  return createHash('sha256').update(domain, 'utf8').update(projection, 'utf8').digest('hex');
}

export function digestMessageBundleQuoteProjection(projection: string): string {
  return digest(MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN, projection);
}

export function digestMessageBundleQuoteProjectionV2(projection: string): string {
  return digest(MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN_V2, projection);
}

export function digestMessageBundleQuoteProjectionV3(projection: string): string {
  return digest(MESSAGE_BUNDLE_QUOTE_DIGEST_DOMAIN_V3, projection);
}

export function digestMessageBundleCliQuoteProjection(projection: string): string {
  return digest(MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN, projection);
}

export function digestMessageBundleCliQuoteProjectionV2(projection: string): string {
  return digest(MESSAGE_BUNDLE_CLI_QUOTE_DIGEST_DOMAIN_V2, projection);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Rich Block digest rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`Rich Block digest rejects ${typeof value}`);
}

export function digestMessageBundleRichBlockProjection(block: RichBlock): string {
  return digest(MESSAGE_BUNDLE_RICH_BLOCK_DIGEST_DOMAIN, canonicalJson(block));
}
