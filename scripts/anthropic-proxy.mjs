#!/usr/bin/env node

/**
 * Anthropic API Gateway Proxy
 *
 * All api_key profile requests are routed through this proxy automatically.
 * Target resolution: reads registered upstreams from a JSON config file.
 * Each upstream gets a slug; CLI baseUrl is set to http://localhost:PORT/SLUG
 * and the proxy strips the slug prefix, forwarding to the real upstream.
 *
 * Config file: .cat-cafe/proxy-upstreams.json (auto-managed by API)
 *   { "my-gateway": "https://your-gateway.example.com/api" }
 *
 * Request flow:
 *   CLI → http://127.0.0.1:9877/my-gateway/v1/messages
 *   Proxy strips "/my-gateway" → forwards to https://your-gateway.example.com/api/v1/messages
 *
 * Startup: automatically started by start-dev.sh
 * Disable: ANTHROPIC_PROXY_ENABLED=0 (skip proxy, CLI connects to upstream directly)
 * Config:  ANTHROPIC_PROXY_PORT (default 9877), ANTHROPIC_PROXY_DEBUG=1
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const PORT = parseInt(getArg('port') || process.env.ANTHROPIC_PROXY_PORT || '9877', 10);
const DEBUG = args.includes('--debug') || process.env.ANTHROPIC_PROXY_DEBUG === '1';
const UPSTREAMS_PATH =
  getArg('upstreams') ||
  process.env.ANTHROPIC_PROXY_UPSTREAMS_PATH ||
  resolve(PROJECT_ROOT, '.cat-cafe', 'proxy-upstreams.json');
const MAX_RETRIES = parseCount(getArg('max-retries') || process.env.ANTHROPIC_PROXY_MAX_RETRIES, 3);
const UPSTREAM_TIMEOUT_MS = parseInt(
  getArg('upstream-timeout') || process.env.ANTHROPIC_PROXY_UPSTREAM_TIMEOUT_MS || '60000',
  10,
);
const RETRYABLE_HTTP_STATUSES = new Set([429, 529]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function parseCount(rawValue, fallback) {
  if (rawValue == null) return fallback;
  const parsed = Number.parseInt(String(rawValue), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildRetryDelayMs(attempt, kind, retryAfterHeader) {
  if (kind === 'http_status') {
    const retryAfter = retryAfterHeader ? Math.min(Number(retryAfterHeader) || 1, 30) : 2 ** attempt;
    return retryAfter * 1000;
  }
  return 250 * 2 ** attempt;
}

function extractCauseCode(err) {
  if (typeof err?.causeCode === 'string') return err.causeCode;
  if (typeof err?.cause?.code === 'string') return err.cause.code;
  if (typeof err?.code === 'string') return err.code;
  if (err?.name === 'TimeoutError') return 'UPSTREAM_TIMEOUT';
  return undefined;
}

function isRetryableNetworkError(err) {
  const causeCode = extractCauseCode(err);
  if (causeCode) return RETRYABLE_NETWORK_CODES.has(causeCode);
  return err instanceof TypeError && err.message === 'fetch failed';
}

function formatUpstreamErrorMessage(causeCode, err) {
  switch (causeCode) {
    case 'UPSTREAM_TIMEOUT':
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return 'upstream request timed out';
    case 'ECONNREFUSED':
      return 'upstream connection refused';
    case 'ECONNRESET':
      return 'upstream connection reset';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'upstream host lookup failed';
    default:
      return err instanceof Error ? err.message : 'upstream request failed';
  }
}

function createProxyError(err, fallbackStatus = 502) {
  const isTimeout = err?.name === 'TimeoutError';
  const causeCode = extractCauseCode(err);
  return {
    status: isTimeout ? 504 : typeof err?.status === 'number' ? err.status : fallbackStatus,
    body: {
      type: 'error',
      error: {
        type: isTimeout ? 'proxy_timeout' : 'proxy_error',
        message: formatUpstreamErrorMessage(causeCode, err),
        ...(causeCode ? { causeCode } : {}),
        ...(err?.retryable === true ? { retryable: true } : {}),
      },
    },
  };
}

/** Load upstream mapping from config file. Re-read on each request for hot-reload. */
function loadUpstreams() {
  try {
    const raw = readFileSync(UPSTREAMS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// --- Request body sanitization ---
// Third-party gateways (e.g. Felix-2) may strip/modify thinking content from
// responses while preserving the original Anthropic signature. On the next turn,
// Claude Code sends back these thinking blocks with mismatched content+signature,
// causing "Invalid signature in thinking block" 400 errors.
// Fix: strip thinking/redacted_thinking blocks from previous assistant messages
// in the request body before forwarding. The model loses previous reasoning
// context but avoids the fatal signature validation failure.

function stripThinkingFromRequest(bodyBuffer) {
  if (bodyBuffer.length === 0) return bodyBuffer;
  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString('utf-8'));
  } catch {
    return bodyBuffer;
  }
  if (!parsed.messages || !Array.isArray(parsed.messages)) return bodyBuffer;

  let modified = false;
  for (const msg of parsed.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const filtered = msg.content.filter((block) => block?.type !== 'thinking' && block?.type !== 'redacted_thinking');
    if (filtered.length !== msg.content.length) {
      msg.content = filtered;
      modified = true;
    }
  }

  if (!modified) return bodyBuffer;
  return Buffer.from(JSON.stringify(parsed), 'utf-8');
}

// --- SSE normalization for non-standard upstream responses ---
// Known quirks (some third-party gateways):
// 1. message_start.usage.input_tokens = 0 (should be real count)
// 2. message_delta.usage.input_tokens = real count (non-standard, Anthropic only puts output_tokens here)
// 3. Extra fields: usage.cache_creation (nested), usage.inference_geo, usage.service_tier
// 4. Extra field: message.output
//
// Fix strategy: rewrite SSE events inline to normalize usage fields.
// For input_tokens: if message_start had input_tokens:0 and message_delta
// carries the real value, emit a corrective message_start event with the
// real token count that downstream parsers can pick up.

const USAGE_STRIP_KEYS = ['cache_creation', 'inference_geo', 'service_tier'];

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return usage;
  const cleaned = { ...usage };
  for (const key of USAGE_STRIP_KEYS) {
    delete cleaned[key];
  }
  return cleaned;
}

// --- Content block normalization ---
// Felix-2 gateway adds non-standard fields to thinking blocks (e.g. extra metadata).
// Claude Code stores the assembled response in session history; on the next turn the
// Anthropic API rejects the request with "Invalid value in thinking block".
// Fix: whitelist only standard fields for each content block type.

const THINKING_BLOCK_KEYS = ['type', 'thinking', 'signature'];
const THINKING_DELTA_KEYS = ['type', 'thinking'];
const REDACTED_THINKING_BLOCK_KEYS = ['type', 'data'];

function pickKeys(obj, allowedKeys) {
  const result = {};
  for (const key of allowedKeys) {
    if (key in obj) result[key] = obj[key];
  }
  return result;
}

function normalizeContentBlock(block) {
  if (!block || typeof block !== 'object') return block;
  if (block.type === 'thinking') return pickKeys(block, THINKING_BLOCK_KEYS);
  if (block.type === 'redacted_thinking') return pickKeys(block, REDACTED_THINKING_BLOCK_KEYS);
  return block;
}

function normalizeDelta(delta) {
  if (!delta || typeof delta !== 'object') return delta;
  if (delta.type === 'thinking_delta') return pickKeys(delta, THINKING_DELTA_KEYS);
  return delta;
}

/**
 * Parse and rewrite SSE events in a chunk. Returns the rewritten chunk.
 * Also tracks message_start input_tokens to detect the 0-value quirk.
 */
function rewriteSSEChunk(text, state) {
  // SSE events are separated by double newlines.
  // A chunk may contain partial events; accumulate in state.buffer.
  const input = (state.buffer || '') + text;
  // SSE spec allows \r\n line endings; normalize before splitting
  const parts = input.replace(/\r\n/g, '\n').split('\n\n');
  // Last part may be incomplete — save it
  state.buffer = parts.pop() || '';

  let output = '';
  for (const part of parts) {
    if (!part.trim()) {
      output += '\n\n';
      continue;
    }

    const eventMatch = part.match(/^event:\s*(.+)/m);
    const dataMatch = part.match(/^data:\s*(.+)/m);
    const eventType = eventMatch?.[1]?.trim();
    const rawData = dataMatch?.[1];

    if (!rawData || !eventType) {
      output += `${part}\n\n`;
      continue;
    }

    let data;
    try {
      data = JSON.parse(rawData);
    } catch {
      output += `${part}\n\n`;
      continue;
    }

    if (eventType === 'message_start') {
      const msg = data.message;
      if (msg) {
        delete msg.output; // non-standard
        if (msg.usage) msg.usage = normalizeUsage(msg.usage);
        // Track if input_tokens was 0 (broken upstream)
        state.messageStartInputZero = msg.usage?.input_tokens === 0;
      }
      output += `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    } else if (eventType === 'message_delta') {
      // Capture real input_tokens from delta (non-standard but present in some gateways)
      const deltaInputTokens = data.usage?.input_tokens;
      if (data.usage) data.usage = normalizeUsage(data.usage);
      output += `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
      // If message_start had input_tokens:0 and delta has the real value,
      // emit a correction event that our NDJSON parser can pick up.
      if (state.messageStartInputZero && typeof deltaInputTokens === 'number' && deltaInputTokens > 0) {
        const correction = {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: deltaInputTokens,
              cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
            },
          },
        };
        output += `event: message_start\ndata: ${JSON.stringify(correction)}\n\n`;
        state.messageStartInputZero = false;
      }
    } else if (eventType === 'content_block_start') {
      // Normalize thinking/redacted_thinking content blocks to strip non-standard fields
      if (data.content_block) {
        data.content_block = normalizeContentBlock(data.content_block);
      }
      output += `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    } else if (eventType === 'content_block_delta') {
      // Normalize thinking_delta to strip non-standard fields
      if (data.delta) {
        data.delta = normalizeDelta(data.delta);
      }
      output += `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    } else {
      // Pass through other events unchanged (incl. content_block_stop, message_stop, ping)
      output += `${part}\n\n`;
    }
  }
  return output;
}

let requestCounter = 0;

const server = createServer(async (req, res) => {
  const reqId = ++requestCounter;
  const path = req.url || '/';

  // Parse slug from path: /SLUG/v1/messages → slug="SLUG", rest="/v1/messages"
  const match = path.match(/^\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  if (!match) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: `Invalid path: ${path}. Expected /<upstream-slug>/...` },
      }),
    );
    return;
  }

  const slug = match[1];
  const restPath = match[2] || '/';

  const upstreams = loadUpstreams();
  const targetBase = upstreams[slug]?.replace(/\/+$/, '');

  if (!targetBase) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'proxy_error',
          message: `Unknown upstream "${slug}". Known: [${Object.keys(upstreams).join(', ')}]`,
        },
      }),
    );
    return;
  }

  // NB: Do NOT use `new URL(restPath, targetBase)` — when restPath is absolute
  // (starts with "/"), the URL constructor discards the base URL's path component.
  // e.g. new URL("/v1/messages", "https://example.com/prefix") → "https://example.com/v1/messages"
  // We need: "https://example.com/prefix/v1/messages"
  const targetUrl = new URL(targetBase + restPath);

  if (DEBUG) {
    console.log(`[proxy #${reqId}] ${req.method} ${path} → [${slug}] ${targetUrl.href}`);
  }

  // Collect request body
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  if (DEBUG && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      console.log(
        `[proxy #${reqId}] model=${parsed.model}, stream=${parsed.stream}, thinking=${JSON.stringify(parsed.thinking)}`,
      );
    } catch {
      /* not JSON */
    }
  }

  // Sanitize request body: strip thinking blocks from conversation history
  // to prevent "Invalid signature in thinking block" errors from corrupted
  // gateway responses stored in Claude Code sessions.
  const sanitizedBody = stripThinkingFromRequest(body);
  if (DEBUG && sanitizedBody.length !== body.length) {
    console.log(
      `[proxy #${reqId}] stripped thinking blocks from request (${body.length} → ${sanitizedBody.length} bytes)`,
    );
  }

  // Forward headers (strip hop-by-hop)
  // P1 fix: Force identity encoding so upstream doesn't gzip the response.
  // Node fetch auto-decompresses but keeps the content-encoding header,
  // causing downstream to double-decompress → ZlibError.
  const forwardHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === 'host' || key === 'connection') continue;
    if (key === 'accept-encoding') continue; // override below
    if (key === 'content-length' || key === 'transfer-encoding') continue;
    forwardHeaders[key] = value;
  }
  forwardHeaders['accept-encoding'] = 'identity';

  try {
    // Retry loop for transient upstream errors (HTTP backpressure + network blips)
    let upstream;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Connect-only timeout: abort if upstream doesn't respond with headers
      // within UPSTREAM_TIMEOUT_MS, but do NOT abort mid-stream once headers arrive.
      const connectController = new AbortController();
      const connectTimer = setTimeout(() => {
        connectController.abort(new DOMException('upstream connect timeout', 'TimeoutError'));
      }, UPSTREAM_TIMEOUT_MS);

      try {
        upstream = await fetch(targetUrl.href, {
          method: req.method || 'GET',
          headers: forwardHeaders,
          ...(sanitizedBody.length > 0 ? { body: sanitizedBody } : {}),
          signal: connectController.signal,
        });
      } catch (err) {
        const causeCode = extractCauseCode(err);
        const retryable = isRetryableNetworkError(err);
        if (retryable && attempt < MAX_RETRIES) {
          const delayMs = buildRetryDelayMs(attempt, 'network_error');
          console.warn(
            `[proxy #${reqId}] upstream ${causeCode ?? 'NETWORK_ERROR'}, retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        if (causeCode) err.causeCode = causeCode;
        err.retryable = retryable;
        throw err;
      } finally {
        // Headers received (or error thrown) — cancel the connect timeout
        // so it does not fire during body streaming.
        clearTimeout(connectTimer);
      }

      if (RETRYABLE_HTTP_STATUSES.has(upstream.status) && attempt < MAX_RETRIES) {
        const delayMs = buildRetryDelayMs(attempt, 'http_status', upstream.headers.get('retry-after'));
        console.log(
          `[proxy #${reqId}] upstream ${upstream.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delayMs / 1000)}s`,
        );
        // Drain the body to free the connection
        await upstream.text().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      break;
    }

    const responseHeaders = {};
    for (const [key, value] of upstream.headers.entries()) {
      // Strip hop-by-hop + encoding headers that Node fetch already handled
      if (
        ['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length'].includes(
          key.toLowerCase(),
        )
      )
        continue;
      responseHeaders[key] = value;
    }

    const isSSE = (upstream.headers.get('content-type') || '').includes('text/event-stream');

    res.writeHead(upstream.status, responseHeaders);

    if (!upstream.body) {
      const text = await upstream.text();
      res.end(text);
      if (DEBUG) console.log(`[proxy #${reqId}] done (no body), status=${upstream.status}`);
      return;
    }

    const reader = upstream.body.getReader();
    let totalBytes = 0;
    const sseState = {}; // SSE rewrite state (buffer, tracking)
    // P1 fix: Use TextDecoder in streaming mode to handle multi-byte UTF-8
    // characters split across chunk boundaries (e.g. CJK, emoji).
    const textDecoder = new TextDecoder('utf-8');

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;

        if (isSSE) {
          // stream: true keeps incomplete multi-byte sequences for next chunk
          const raw = textDecoder.decode(value, { stream: true });
          const rewritten = rewriteSSEChunk(raw, sseState);
          if (rewritten) res.write(rewritten);

          if (DEBUG) {
            const events = raw.match(/event:\s*(\S+)/g);
            if (events) console.log(`[proxy #${reqId}] SSE events: ${events.join(', ')}`);
          }
        } else {
          res.write(value);
        }
      }
      // Flush TextDecoder (any remaining bytes from incomplete multi-byte sequence)
      if (isSSE) {
        const flushed = textDecoder.decode(); // no args = flush
        if (flushed) {
          const rewritten = rewriteSSEChunk(flushed, sseState);
          if (rewritten) res.write(rewritten);
        }
      }
      // Flush any remaining SSE buffer through normalization (not raw!)
      if (isSSE && sseState.buffer?.trim()) {
        const finalRewritten = rewriteSSEChunk(`${sseState.buffer}\n\n`, sseState);
        if (finalRewritten) res.write(finalRewritten);
      }
    } catch (streamErr) {
      if (DEBUG) console.error(`[proxy #${reqId}] stream error:`, streamErr.message);
    } finally {
      res.end();
      if (DEBUG)
        console.log(`[proxy #${reqId}] done, ${totalBytes} bytes${isSSE ? ' (SSE)' : ''}, status=${upstream.status}`);
    }
  } catch (err) {
    const { status, body: errorBody } = createProxyError(err);
    console.error(
      `[proxy #${reqId}] ${err?.name === 'TimeoutError' ? 'upstream timeout' : 'upstream error'}:`,
      err instanceof Error ? err.message : String(err),
      err?.cause ? `(cause: ${err.cause.message || err.cause})` : '',
      err?.causeCode ? `(code: ${err.causeCode})` : '',
    );
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify(errorBody));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const upstreams = loadUpstreams();
  const slugs = Object.keys(upstreams);
  console.log(`[anthropic-proxy] listening on http://127.0.0.1:${PORT}`);
  console.log(`[anthropic-proxy] upstreams file: ${UPSTREAMS_PATH}`);
  console.log(`[anthropic-proxy] upstreams: ${slugs.length > 0 ? slugs.join(', ') : '(none)'}`);
  console.log(`[anthropic-proxy] upstream timeout: ${UPSTREAM_TIMEOUT_MS}ms`);
  console.log(`[anthropic-proxy] debug: ${DEBUG ? 'ON' : 'OFF'}`);
});
