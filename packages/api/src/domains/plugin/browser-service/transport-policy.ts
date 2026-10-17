import { Buffer } from 'node:buffer';
import {
  type BrowserServiceContribution,
  type BrowserServiceRequest,
  type BrowserServiceResponse,
  validateBrowserServiceRequest,
  validateBrowserServiceResponse,
} from '@clowder-ai/plugin-contract';
import type { PluginBrowserServiceBinding } from '../host-surface/plugin-browser-service-host.js';

export const BROWSER_SERVICE_LIMITS = Object.freeze({
  requestBytes: 262144,
  responseBytes: 33554432,
  headerFields: 32,
  headerValueBytes: 8192,
  headerBytes: 32768,
  targetBytes: 8192,
  timeoutMs: 10000,
} as const);
export type TransportCode =
  | 'BROWSER_SERVICE_UNAVAILABLE'
  | 'BROWSER_SERVICE_REVOKED'
  | 'BROWSER_SERVICE_BUSY'
  | 'BROWSER_SERVICE_INVALID_REQUEST'
  | 'BROWSER_SERVICE_REQUEST_TOO_LARGE'
  | 'BROWSER_SERVICE_INVALID_RESPONSE'
  | 'BROWSER_SERVICE_RESPONSE_TOO_LARGE'
  | 'BROWSER_SERVICE_TIMEOUT';
export class BrowserServiceTransportError extends Error {
  constructor(readonly code: TransportCode) {
    super(code);
  }
}
function invalidRequest(): never {
  throw new BrowserServiceTransportError('BROWSER_SERVICE_INVALID_REQUEST');
}
function invalidResponse(): never {
  throw new BrowserServiceTransportError('BROWSER_SERVICE_INVALID_RESPONSE');
}

/** Base64 groups round up; padding must count when classifying the last decoded byte. */
function bodyExceedsLimit(value: unknown, limit: number): boolean {
  if (typeof value !== 'string') return false;
  // Bound the encoded input before examining it. Canonical validity is checked separately.
  return value.length > Math.ceil(limit / 3) * 4 || Buffer.byteLength(value, 'base64') > limit;
}

/** Return only declared business cookies; ambient Host cookies never cross the boundary. */
function businessCookies(value: string, contribution: BrowserServiceContribution): string {
  const declared = new Set(contribution.credentials.cookies.map((cookie) => cookie.name));
  const result: string[] = [],
    seen = new Set<string>();
  for (const part of value.split(';')) {
    const pair = part.trim();
    const separator = pair.indexOf('=');
    if (separator < 1) invalidRequest();
    const name = pair.slice(0, separator);
    if (!declared.has(name)) continue;
    if (seen.has(name)) invalidRequest();
    seen.add(name);
    result.push(pair);
  }
  return result.join('; ');
}

export function admitBrowserServiceRequest(
  value: unknown,
  lane: 'browser' | 'local',
  contribution: BrowserServiceContribution,
  binding: Pick<PluginBrowserServiceBinding, 'origin' | 'parentOrigin'>,
): BrowserServiceRequest {
  if (
    value &&
    typeof value === 'object' &&
    'rawBodyBase64' in value &&
    bodyExceedsLimit(value.rawBodyBase64, BROWSER_SERVICE_LIMITS.requestBytes)
  )
    throw new BrowserServiceTransportError('BROWSER_SERVICE_REQUEST_TOO_LARGE');
  if (!validateBrowserServiceRequest(value)) invalidRequest();
  const route = contribution.routes.find((route) => route.method === value.method && route.path === value.path);
  if (!route || !(lane === 'browser' ? route.browser : route.local)) invalidRequest();
  const origin = value.headers.find((header) => header.name === 'origin')?.value;
  if (lane === 'local') {
    if (value.headers.some((header) => header.name === 'cookie')) invalidRequest();
    if (route.local === 'parent-origin' ? origin !== binding.parentOrigin : origin !== undefined) invalidRequest();
  } else if (route.browser === 'parent') {
    if (origin !== binding.parentOrigin) invalidRequest();
  } else {
    if (origin !== undefined && origin !== binding.origin) invalidRequest();
    if (value.method !== 'GET' && origin !== binding.origin) invalidRequest();
  }
  const headers = value.headers.flatMap((header) => {
    if (header.name === 'authorization' && !contribution.credentials.bearer) invalidRequest();
    if (header.name !== 'cookie') return [Object.freeze({ ...header })];
    const cookies = businessCookies(header.value, contribution);
    return cookies ? [Object.freeze({ name: 'cookie', value: cookies })] : [];
  });
  return Object.freeze({ ...value, headers: Object.freeze(headers) });
}

function validateCookie(value: string, contribution: BrowserServiceContribution, secure: boolean): string {
  const [pair, ...parts] = value.split(';').map((part) => part.trim());
  const match = pair?.match(/^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=([\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*)$/);
  if (!match) invalidResponse();
  const cookie = contribution.credentials.cookies.find((cookie) => cookie.name === match[1]);
  if (!cookie) invalidResponse();
  const attributes = new Map<string, string>();
  for (const part of parts) {
    const equal = part.indexOf('=');
    const name = (equal < 0 ? part : part.slice(0, equal)).toLowerCase();
    if (attributes.has(name) || !['path', 'httponly', 'samesite', 'max-age', 'secure'].includes(name))
      invalidResponse();
    attributes.set(name, equal < 0 ? '' : part.slice(equal + 1));
  }
  if (
    attributes.get('path') !== cookie.path ||
    attributes.get('httponly') !== '' ||
    attributes.get('samesite')?.toLowerCase() !== 'strict' ||
    !['0', String(cookie.maxAgeSeconds)].includes(attributes.get('max-age') ?? '') ||
    (secure ? attributes.get('secure') !== '' : attributes.has('secure'))
  )
    invalidResponse();
  return cookie.name;
}
export function admitBrowserServiceResponse(
  value: unknown,
  contribution: BrowserServiceContribution,
  origin: string,
): BrowserServiceResponse {
  if (
    value &&
    typeof value === 'object' &&
    'bodyBase64' in value &&
    bodyExceedsLimit(value.bodyBase64, BROWSER_SERVICE_LIMITS.responseBytes)
  )
    throw new BrowserServiceTransportError('BROWSER_SERVICE_RESPONSE_TOO_LARGE');
  if (!validateBrowserServiceResponse(value)) invalidResponse();
  const cookies = new Set<string>();
  for (const header of value.headers) {
    if (header.name === 'location' && new URL(header.value, origin).origin !== origin) invalidResponse();
    if (header.name !== 'set-cookie') continue;
    const name = validateCookie(header.value, contribution, origin.startsWith('https:'));
    if (cookies.has(name)) invalidResponse();
    cookies.add(name);
  }
  return Object.freeze({
    ...value,
    headers: Object.freeze(value.headers.map((header) => Object.freeze({ ...header }))),
  });
}
