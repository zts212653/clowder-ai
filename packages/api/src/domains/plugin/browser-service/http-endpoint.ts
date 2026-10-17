import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import type { BrowserServiceContribution, BrowserServiceDispatchResult } from '@clowder-ai/plugin-contract';
import { BrowserServiceDispatcher } from './dispatch.js';
import type { RetainedBrowserAssets } from './retained-assets.js';
import { BROWSER_SERVICE_LIMITS, BrowserServiceTransportError, type TransportCode } from './transport-policy.js';

const statusFor: Record<TransportCode, number> = {
  BROWSER_SERVICE_UNAVAILABLE: 503,
  BROWSER_SERVICE_BUSY: 503,
  BROWSER_SERVICE_REVOKED: 410,
  BROWSER_SERVICE_INVALID_REQUEST: 400,
  BROWSER_SERVICE_REQUEST_TOO_LARGE: 413,
  BROWSER_SERVICE_INVALID_RESPONSE: 502,
  BROWSER_SERVICE_RESPONSE_TOO_LARGE: 502,
  BROWSER_SERVICE_TIMEOUT: 504,
};
const forwarded = new Set(['accept', 'content-type', 'authorization', 'cookie', 'origin']);
function invalid(): never {
  throw new BrowserServiceTransportError('BROWSER_SERVICE_INVALID_REQUEST');
}
function errorResult(
  code: TransportCode,
  effect: 'not_started' | 'unknown' = 'not_started',
): BrowserServiceDispatchResult {
  return { kind: 'transport-error', code, effect, automaticRetry: false };
}
function securityHeaders(res: ServerResponse, parentOrigin: string) {
  res.setHeader(
    'content-security-policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${parentOrigin}`,
  );
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}
function sendResult(res: ServerResponse, result: BrowserServiceDispatchResult) {
  if (res.destroyed) return;
  if (result.kind === 'transport-error') {
    res.writeHead(statusFor[result.code], { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(result));
    return;
  }
  res.statusCode = result.response.status;
  const cookies: string[] = [];
  for (const header of result.response.headers) {
    if (header.name === 'set-cookie') cookies.push(header.value);
    else res.setHeader(header.name, header.value);
  }
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end(Buffer.from(result.response.bodyBase64, 'base64'));
}
function requestHead(req: IncomingMessage, origin: string) {
  if (req.rawHeaders.length / 2 > BROWSER_SERVICE_LIMITS.headerFields) invalid();
  let bytes = 0;
  const headers: { name: string; value: string }[] = [];
  let hostCount = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const rawName = req.rawHeaders[i],
      value = req.rawHeaders[i + 1];
    if (rawName === undefined || value === undefined) invalid();
    const name = rawName.toLowerCase();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (
      Buffer.byteLength(value) > BROWSER_SERVICE_LIMITS.headerValueBytes ||
      bytes > BROWSER_SERVICE_LIMITS.headerBytes
    )
      invalid();
    if (name === 'host') {
      hostCount++;
      if (value !== new URL(origin).host) invalid();
    }
    if (forwarded.has(name)) headers.push({ name, value });
  }
  if (hostCount !== 1) invalid();
  const target = req.url ?? '';
  if (
    !target.startsWith('/') ||
    target.startsWith('//') ||
    Buffer.byteLength(target) > BROWSER_SERVICE_LIMITS.targetBytes
  )
    invalid();
  const question = target.indexOf('?');
  return {
    headers,
    path: question < 0 ? target : target.slice(0, question),
    rawQuery: question < 0 ? '' : target.slice(question + 1),
  };
}
async function requestBody(req: IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const pieces: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', fail);
      req.off('aborted', aborted);
      signal.removeEventListener('abort', aborted);
    };
    const fail = (error: unknown) => {
      cleanup();
      req.pause();
      reject(error);
    };
    const aborted = () => fail(new BrowserServiceTransportError('BROWSER_SERVICE_REVOKED'));
    const data = (piece: Buffer) => {
      size += piece.length;
      if (size > BROWSER_SERVICE_LIMITS.requestBytes) {
        fail(new BrowserServiceTransportError('BROWSER_SERVICE_REQUEST_TOO_LARGE'));
        return;
      }
      pieces.push(piece);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(pieces, size).toString('base64'));
    };
    req.on('data', data);
    req.once('end', end);
    req.once('error', fail);
    req.once('aborted', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
interface EndpointOptions {
  readonly parentOrigin: string;
  readonly contribution: BrowserServiceContribution;
  readonly assets: RetainedBrowserAssets;
  readonly signal: AbortSignal;
  origin(): string;
  published(): boolean;
  assertCurrent(): Promise<void>;
  dispatcher(): BrowserServiceDispatcher;
}

function requestOrigin(head: ReturnType<typeof requestHead>): string | undefined {
  const origins = head.headers.filter((h) => h.name === 'origin');
  if (origins.length > 1) invalid();
  return origins[0]?.value;
}
function preflight(
  req: IncomingMessage,
  res: ServerResponse,
  head: ReturnType<typeof requestHead>,
  options: EndpointOptions,
) {
  const method = req.headers['access-control-request-method'];
  const declared = options.contribution.routes.find(
    (r) => r.path === head.path && r.method === method && r.browser === 'parent',
  );
  if (!declared || requestOrigin(head) !== options.parentOrigin || head.rawQuery) invalid();
  const requested = String(req.headers['access-control-request-headers'] ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (requested.some((h) => !['accept', 'content-type', 'authorization'].includes(h))) invalid();
  res.writeHead(204, {
    'access-control-allow-origin': options.parentOrigin,
    'access-control-allow-methods': declared.method,
    'access-control-allow-headers': requested.join(', '),
    vary: 'Origin',
  });
  res.end();
}
async function publicResource(
  req: IncomingMessage,
  res: ServerResponse,
  head: ReturnType<typeof requestHead>,
  options: EndpointOptions,
  signal: AbortSignal,
): Promise<boolean> {
  if (req.method === 'OPTIONS') {
    preflight(req, res, head, options);
    return true;
  }
  // Launch parameters belong to the client; sealed asset identity is the pathname.
  const asset = req.method === 'GET' ? options.assets.read(head.path) : undefined;
  if (!asset) return false;
  const origin = requestOrigin(head);
  if (origin !== undefined && origin !== options.origin() && origin !== options.parentOrigin) invalid();
  if ((req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'])
    invalid();
  await options.assertCurrent();
  signal.throwIfAborted();
  res.writeHead(200, { 'content-type': asset.contentType, 'cache-control': 'no-cache' });
  res.end(asset.bytes);
  return true;
}
function parentCors(
  req: IncomingMessage,
  res: ServerResponse,
  head: ReturnType<typeof requestHead>,
  options: EndpointOptions,
) {
  const route = options.contribution.routes.find((r) => r.path === head.path && r.method === req.method);
  if (route?.browser === 'parent' && requestOrigin(head) === options.parentOrigin) {
    res.setHeader('access-control-allow-origin', options.parentOrigin);
    res.setHeader('vary', 'Origin');
  }
}

/** The only browser entry: owns live HTTP objects and never gives a socket to package code. */
export function createBrowserRequestHandler(options: EndpointOptions): RequestListener {
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const connection = new AbortController();
    let timedOut = false,
      mayHaveEntered = false;
    const disconnected = () => connection.abort();
    res.once('close', disconnected);
    const timeout = setTimeout(() => {
      timedOut = true;
      connection.abort();
    }, BROWSER_SERVICE_LIMITS.timeoutMs);
    timeout.unref();
    const signal = AbortSignal.any([connection.signal, options.signal]);
    securityHeaders(res, options.parentOrigin);
    try {
      const head = requestHead(req, options.origin());
      if (!options.published()) {
        sendResult(res, errorResult('BROWSER_SERVICE_UNAVAILABLE'));
        return;
      }
      await options.assertCurrent();
      signal.throwIfAborted();
      if (await publicResource(req, res, head, options, signal)) return;
      parentCors(req, res, head, options);
      const body = await requestBody(req, signal);
      mayHaveEntered = true;
      const result = await options
        .dispatcher()
        .dispatch('browser', { version: 1, method: req.method, ...head, rawBodyBase64: body }, signal);
      mayHaveEntered = result.kind === 'response' || result.effect === 'unknown';
      // Recheck immediately before writing any bytes/cookies to the real socket.
      await options.assertCurrent();
      signal.throwIfAborted();
      sendResult(res, result);
    } catch (error) {
      if (!res.destroyed) {
        res.setHeader('connection', 'close');
        sendResult(
          res,
          errorResult(
            timedOut
              ? 'BROWSER_SERVICE_TIMEOUT'
              : error instanceof BrowserServiceTransportError
                ? error.code
                : 'BROWSER_SERVICE_REVOKED',
            mayHaveEntered ? 'unknown' : 'not_started',
          ),
        );
      }
    } finally {
      clearTimeout(timeout);
      res.off('close', disconnected);
      connection.abort();
    }
  };
  return (req, res) => {
    void serve(req, res);
  };
}

/** The listener belongs to the Host, including the intervals without a plugin activation. */
export function createBrowserOriginEndpoint(current: () => RequestListener | undefined) {
  const server = createServer(
    { maxHeaderSize: BROWSER_SERVICE_LIMITS.headerBytes, requestTimeout: 10000, headersTimeout: 10000 },
    (req, res) => {
      // Capture one activation: a request must never move to a replacement handler mid-flight.
      const handler = current();
      if (handler) {
        handler(req, res);
        return;
      }
      // No package code, assets, cookies, credential reflection or redirect in the tombstone.
      res.writeHead(503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        connection: 'close',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify(errorResult('BROWSER_SERVICE_UNAVAILABLE')));
    },
  );
  server.maxHeadersCount = 0;
  return server;
}
