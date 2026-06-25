#!/usr/bin/env node

/**
 * Clowder AI MCP Server — Remote Spike Entry (F247 Phase B1a v4)
 *
 * v4 (2026-06-21 砚砚 R7 HOLD fix):
 *   - P1 #1: Env fail-closed gate before listen() —
 *     缺 token / mode / readonly / cat_id / user_id / agent-key
 *     source 任一 throw 退出。防 env mistakes 退回 open / full
 *     toolset surface.
 *   - P1 #2: Restore output redaction wrapper for outgoing MCP
 *     text. v3 删 redactor + claim "真 toolset 内部有 sanitizer"
 *     是 confabulation (砚砚 grep callback-tools.ts:224 +
 *     evidence-tools.ts:246 实证无通用 redact middleware).
 *     现 wrap response.write/end 在最终输出前过 secret patterns.
 *   - P2: Startup log 准确——"redact module: active (wraps response)"
 *     在 redactor 恢复后才打印；env validation pass 后才打印
 *     listen 状态.
 *
 * v3 (2026-06-21 B1a): 真接 cat-cafe API + cloud-pro-phase0 mode
 *   - 删 echo + 5 mock stub tools
 *   - 注册真 collab + memory toolset (走 cloud-pro-phase0 mode
 *     收窄到 10 项白名单)
 *
 * ⚠️  B1a vs B1 production:
 *   B1a: ?token= interim guard + 真 toolset + 真 cat-cafe API
 *   B1: verified CF Access OAuth 或 verified header-auth
 *   本文件是 B1a, F247 KD-7.
 *
 * F247 doc: docs/features/F247-cloud-cat-family.md
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerCollabToolset, registerMemoryToolset } from './server-toolsets.js';
import { initCatCafeDir } from './utils/path-validator.js';

const HOST = '127.0.0.1' as const;
const PORT = Number.parseInt(process.env.CAT_CAFE_REMOTE_PORT ?? '3098', 10);

// === Redact module (CodexPro F5 inspired, 砚砚 R7 P1 restore) =========
// 砚砚 R7 verify_before_guessing 抓: cat-cafe callback/evidence tools
// 不自带 generic output redact. 这一层 wrap response.write/end 在最终
// 输出前过 secret patterns. 48 R2 P0 暴露面减一档.

const SECRET_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{36,}/g, // GitHub Personal Access Token
  /ghs_[A-Za-z0-9]{36,}/g, // GitHub server token
  /github_pat_[A-Za-z0-9_]{82,}/g, // GitHub fine-grained PAT
  /sk-[A-Za-z0-9_-]{32,}/g, // OpenAI API key
  /xoxb-[A-Za-z0-9-]+/g, // Slack bot token
  /xoxp-[A-Za-z0-9-]+/g, // Slack user token
  /AKIA[0-9A-Z]{16}/g, // AWS access key ID
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key
];

function redactSecrets(text: string): string {
  let out = text;
  for (const pat of SECRET_PATTERNS) out = out.replace(pat, '[REDACTED-SECRET]');
  return out;
}

/**
 * Wrap http.ServerResponse so every write/end call passes through
 * redactSecrets. Handles both string and Buffer chunks. MCP Streamable
 * HTTP uses chunked SSE-style writes; we redact each chunk independently.
 * Caveat: secret patterns split across chunk boundaries may slip
 * through — acceptable for B1a, B1 production should use a streaming
 * redact state machine or buffer entire response.
 */
function redactChunk(chunk: unknown): unknown {
  if (typeof chunk === 'string') return redactSecrets(chunk);
  if (chunk instanceof Buffer) return Buffer.from(redactSecrets(chunk.toString('utf-8')), 'utf-8');
  // 砚砚 R11 P1: StreamableHTTPServerTransport (via SDK Hono node adapter) writes
  // Web Response bodies as Uint8Array chunks. Without this branch the bytes fall
  // through `return chunk` and a token in tool output bypasses redaction on the
  // public /mcp surface. Buffer is a subclass of Uint8Array, so order matters —
  // Buffer check above handles that path verbatim; this branch covers raw
  // Uint8Array + any other ArrayBuffer view (Int8Array, Uint8ClampedArray, etc.).
  if (chunk instanceof Uint8Array) {
    return Buffer.from(redactSecrets(Buffer.from(chunk).toString('utf-8')), 'utf-8');
  }
  if (ArrayBuffer.isView(chunk)) {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return Buffer.from(redactSecrets(Buffer.from(bytes).toString('utf-8')), 'utf-8');
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(redactSecrets(Buffer.from(new Uint8Array(chunk)).toString('utf-8')), 'utf-8');
  }
  return chunk;
}

function wrapResponseWithRedact(res: http.ServerResponse): http.ServerResponse {
  const origWrite = res.write.bind(res) as (...args: unknown[]) => boolean;
  const origEnd = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;

  res.write = ((chunk: unknown, arg2?: unknown, arg3?: unknown) => {
    const redacted = redactChunk(chunk);
    if (arg3 !== undefined) return origWrite(redacted, arg2, arg3);
    if (arg2 !== undefined) return origWrite(redacted, arg2);
    return origWrite(redacted);
  }) as typeof res.write;

  res.end = ((arg1?: unknown, arg2?: unknown, arg3?: unknown) => {
    const redacted = redactChunk(arg1);
    if (arg3 !== undefined) return origEnd(redacted, arg2, arg3);
    if (arg2 !== undefined) return origEnd(redacted, arg2);
    if (arg1 !== undefined) return origEnd(redacted);
    return origEnd();
  }) as typeof res.end;

  return res;
}

// === Env fail-closed gate (砚砚 R7 P1) ===============================
// 启动前校验所有必需 env。缺一throw 退出 listen 之前. 防 env mistakes
// 退回 open/full toolset surface.

const EXPECTED_MODE = 'cloud-pro-phase0' as const;
const EXPECTED_READONLY = 'true' as const;
const EXPECTED_CAT_ID = 'gpt-pro' as const;

function validateB1aEnv(): void {
  const errors: string[] = [];

  if (!process.env.CAT_CAFE_REMOTE_TOKEN) {
    errors.push('CAT_CAFE_REMOTE_TOKEN missing (B1a interim guard required)');
  }
  if (process.env.CAT_CAFE_DESKTOP_MODE !== EXPECTED_MODE) {
    errors.push(`CAT_CAFE_DESKTOP_MODE must be "${EXPECTED_MODE}" (got: "${process.env.CAT_CAFE_DESKTOP_MODE ?? ''}")`);
  }
  if (process.env.CAT_CAFE_READONLY !== EXPECTED_READONLY) {
    errors.push(`CAT_CAFE_READONLY must be "${EXPECTED_READONLY}" (got: "${process.env.CAT_CAFE_READONLY ?? ''}")`);
  }
  if (process.env.CAT_CAFE_CAT_ID !== EXPECTED_CAT_ID) {
    errors.push(`CAT_CAFE_CAT_ID must be "${EXPECTED_CAT_ID}" (got: "${process.env.CAT_CAFE_CAT_ID ?? ''}")`);
  }
  if (!process.env.CAT_CAFE_USER_ID) {
    errors.push('CAT_CAFE_USER_ID missing');
  }
  // 砚砚 R11 P2: getCallbackConfig() returns null without CAT_CAFE_API_URL, so
  // every collab/memory tool would fail as "Clowder AI callback not configured"
  // while /health still advertised OK. Fail closed at startup instead.
  if (!process.env.CAT_CAFE_API_URL) {
    errors.push(
      'CAT_CAFE_API_URL missing — getCallbackConfig() returns null without it, ' +
        'all collab/memory tools would fail as "Clowder AI callback not configured".',
    );
  }
  // 砚砚 R12 P2: spike-server may be spawned from an existing cat invocation and
  // inherit CAT_CAFE_INVOCATION_ID / CAT_CAFE_CALLBACK_TOKEN. callback-tools.ts
  // gives invocation headers precedence over agent-key auth, so the cloud
  // connector either writes under the wrong invocation principal or its
  // required post_message calls fail (F193 KD-1 rejects threadId in
  // invocation-token mode). Refuse to start if either is set.
  if (process.env.CAT_CAFE_INVOCATION_ID) {
    errors.push(
      'CAT_CAFE_INVOCATION_ID must be unset for B1a — inherited invocation creds ' +
        'take precedence over agent-key auth and F193 KD-1 rejects threadId. ' +
        'Use env -u CAT_CAFE_INVOCATION_ID in the spike startup wrapper.',
    );
  }
  if (process.env.CAT_CAFE_CALLBACK_TOKEN) {
    errors.push(
      'CAT_CAFE_CALLBACK_TOKEN must be unset for B1a — same reason as INVOCATION_ID. ' +
        'Use env -u CAT_CAFE_CALLBACK_TOKEN in the spike startup wrapper.',
    );
  }
  // 砚砚 R10 P1: B1a Custom Instructions mandates `agentKeyCatId="gpt-pro"` on
  // every collab/memory tool call. With `requestedCatId` always set, the callback
  // resolver in callback-tools.ts:92-106 unconditionally takes the variantMap
  // path:
  //   if (requestedCatId) {
  //     const variantFiles = parseAgentKeyFileMap(variantMapRaw);
  //     return readAgentKeyFile(variantFiles[requestedCatId]);
  //   }
  //   // CAT_CAFE_AGENT_KEY_FILE / _SECRET are never reached when requestedCatId is set.
  //
  // So `_FILE` alone (no `_FILES`) cannot rescue B1a once Custom Instructions
  // require `agentKeyCatId`: /health would advertise OK while every compliant
  // collab call fails as callback-not-configured. Validate the variantMap entry
  // here so the public surface fails closed, not the call surface.
  //
  // Falls back to AGENT_KEY_SECRET (callers without agentKeyCatId would still
  // resolve via that path), but in the B1a / cloud-pro-phase0 configuration the
  // map entry is the production source of truth and must exist.
  const agentKeySecret = process.env.CAT_CAFE_AGENT_KEY_SECRET;
  const agentKeyFilesRaw = process.env.CAT_CAFE_AGENT_KEY_FILES;

  if (!agentKeyFilesRaw) {
    errors.push(
      `CAT_CAFE_AGENT_KEY_FILES is required for cloud-pro-phase0 — ` +
        `B1a Custom Instructions enforce agentKeyCatId="${EXPECTED_CAT_ID}", ` +
        `which forces the callback resolver onto the variantMap path. ` +
        `CAT_CAFE_AGENT_KEY_FILE alone never reached.`,
    );
  } else {
    let map: Record<string, unknown> = {};
    let mapParseOk = false;
    try {
      const parsed = JSON.parse(agentKeyFilesRaw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        map = parsed as Record<string, unknown>;
        mapParseOk = true;
      } else {
        errors.push('CAT_CAFE_AGENT_KEY_FILES must be a JSON object {catId: filePath}');
      }
    } catch {
      errors.push('CAT_CAFE_AGENT_KEY_FILES is not valid JSON');
    }

    if (mapParseOk) {
      // 砚砚 R12 P1: tool schemas let the remote caller pick agentKeyCatId, and
      // resolveAgentKeySecret indexes that caller-supplied key. If the inherited
      // map contains other cats (antigravity / antig-opus / etc.), any spike-token
      // holder can pass another catId and authenticate as that cat. Fail closed
      // by requiring the map to contain ONLY EXPECTED_CAT_ID.
      const extraCats = Object.keys(map).filter((k) => k !== EXPECTED_CAT_ID);
      if (extraCats.length > 0) {
        errors.push(
          `CAT_CAFE_AGENT_KEY_FILES contains extra cats [${extraCats.join(', ')}] — ` +
            `spike-token holder could impersonate them by picking input.agentKeyCatId. ` +
            `Override the inherited map to a single-entry "${EXPECTED_CAT_ID}" map in the spike wrapper.`,
        );
      }
      const candidate = map[EXPECTED_CAT_ID];
      if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        errors.push(
          `CAT_CAFE_AGENT_KEY_FILES has no usable "${EXPECTED_CAT_ID}" entry — ` +
            `callback resolver returns undefined for input.agentKeyCatId="${EXPECTED_CAT_ID}".`,
        );
      } else {
        const resolvedPath = candidate.trim();
        const resolutionSource = `CAT_CAFE_AGENT_KEY_FILES["${EXPECTED_CAT_ID}"]`;
        try {
          const stat = fs.statSync(resolvedPath);
          if (!stat.isFile()) {
            errors.push(`${resolutionSource} → ${resolvedPath} is not a regular file`);
          } else {
            // Read to verify accessible + non-empty (don't print contents).
            const content = fs.readFileSync(resolvedPath, 'utf-8').trim();
            if (content.length === 0) {
              errors.push(`${resolutionSource} → ${resolvedPath} is empty`);
            }
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push(`${resolutionSource} → ${resolvedPath} is not readable: ${errMsg}`);
        }
      }
    }
  }

  // AGENT_KEY_SECRET is still accepted as an additional source, but on its own
  // is not enough for cloud-pro-phase0 unless callers omit agentKeyCatId
  // (which Custom Instructions forbid). Document the diagnostic-only role.
  if (agentKeySecret && !agentKeyFilesRaw) {
    errors.push(
      'CAT_CAFE_AGENT_KEY_SECRET is set but CAT_CAFE_AGENT_KEY_FILES is missing — ' +
        '_SECRET alone is unreachable when callers pass agentKeyCatId.',
    );
  }

  if (errors.length > 0) {
    const msg = [
      '[cat-cafe-b1a] FATAL: env validation failed (砚砚 R7 P1 + R9 P1 + R10 P1 + R12 P1+P2 fail-closed gate):',
      ...errors.map((e) => `  - ${e}`),
    ].join('\n');
    throw new Error(msg);
  }
}

// === Token middleware (B1a interim guard, NOT B1 production) ==========

const REMOTE_TOKEN = process.env.CAT_CAFE_REMOTE_TOKEN ?? '';

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function isAuthorized(req: http.IncomingMessage): boolean {
  // 砚砚 R7 P1: validateB1aEnv() 已保证 REMOTE_TOKEN non-empty,
  // 不再 fail-open on missing token. 这里只做 timing-safe compare.
  if (!REMOTE_TOKEN) return false; // defense-in-depth (should never reach if env validated)

  try {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const queryToken = url.searchParams.get('token');
    if (queryToken && timingSafeEqualString(queryToken, REMOTE_TOKEN)) return true;
  } catch {
    // fall through to header
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (match && timingSafeEqualString(match[1], REMOTE_TOKEN)) return true;
  }

  return false;
}

// === MCP server with real cat-cafe toolset (cloud-pro-phase0 mode) ====

function createSpikeServer(): McpServer {
  const server = new McpServer({
    name: 'cat-cafe-cloud-pro-b1a',
    version: '0.0.4-b1a',
  });

  // server-toolsets.applyReadonlyFilter 在 cloud-pro-phase0 mode 下
  // 收窄到 10 项白名单. env 已被 validateB1aEnv 保证 mode 正确.
  registerCollabToolset(server);
  registerMemoryToolset(server);

  return server;
}

// === HTTP handler ====================================================

async function handleMcpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized', hint: 'pass ?token= or Authorization: Bearer' }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: unknown;
  if (chunks.length > 0) {
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json body' }));
      return;
    }
  }

  const server = createSpikeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  try {
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[cat-cafe-b1a] handleRequest error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  }
}

async function main(): Promise<void> {
  validateB1aEnv(); // 砚砚 R7 P1: fail-closed before initCatCafeDir/listen

  initCatCafeDir();

  const server = http.createServer((req, res) => {
    // 砚砚 R7 P1: wrap response with redactor BEFORE any write
    const wrappedRes = wrapResponseWithRedact(res);
    const urlForLog = (req.url ?? '').split('?')[0];
    const jwtHeader = req.headers['cf-access-jwt-assertion'];
    const authHeader = req.headers.authorization;
    console.error(
      `[cat-cafe-b1a] ${req.method} ${urlForLog} cf-jwt=${jwtHeader ? 'present' : 'absent'} auth=${authHeader ? 'present' : 'absent'}`,
    );

    if (urlForLog === '/health' && req.method === 'GET') {
      wrappedRes.writeHead(200, { 'content-type': 'application/json' });
      wrappedRes.end(
        JSON.stringify({
          status: 'ok',
          server: 'cat-cafe-cloud-pro-b1a',
          version: '0.0.4-b1a',
          mode: process.env.CAT_CAFE_DESKTOP_MODE,
          cat_id: process.env.CAT_CAFE_CAT_ID,
        }),
      );
      return;
    }

    if (urlForLog === '/mcp') {
      handleMcpRequest(req, wrappedRes).catch((err) => {
        console.error('[cat-cafe-b1a] uncaught:', err);
        if (!wrappedRes.headersSent) {
          wrappedRes.writeHead(500, { 'content-type': 'application/json' });
          wrappedRes.end(JSON.stringify({ error: 'internal error' }));
        }
      });
      return;
    }

    wrappedRes.writeHead(404, { 'content-type': 'application/json' });
    wrappedRes.end(JSON.stringify({ error: 'not found', hint: 'POST /mcp or GET /health' }));
  });

  server.listen(PORT, HOST, () => {
    console.error(`[cat-cafe-b1a] MCP Streamable HTTP listening on ${HOST}:${PORT}`);
    console.error(
      '[cat-cafe-b1a] Auth: token-required (query ?token= or Bearer header) [B1a interim, NOT B1 production verified auth]',
    );
    console.error('[cat-cafe-b1a] DESKTOP_MODE:', process.env.CAT_CAFE_DESKTOP_MODE);
    console.error('[cat-cafe-b1a] READONLY:', process.env.CAT_CAFE_READONLY);
    console.error('[cat-cafe-b1a] CAT_ID:', process.env.CAT_CAFE_CAT_ID);
    console.error('[cat-cafe-b1a] USER_ID:', process.env.CAT_CAFE_USER_ID);
    console.error('[cat-cafe-b1a] AGENT_KEY_FILE:', process.env.CAT_CAFE_AGENT_KEY_FILE ?? '(via _FILES or _SECRET)');
    console.error('[cat-cafe-b1a] API_URL:', process.env.CAT_CAFE_API_URL ?? '(unset, default)');
    console.error(
      `[cat-cafe-b1a] redact module: active (wraps response.write/end, ${SECRET_PATTERNS.length} patterns)`,
    );
    console.error(
      '[cat-cafe-b1a] toolset: registerCollabToolset + registerMemoryToolset (cloud-pro-phase0 收窄到 10 项)',
    );
    console.error(
      '[cat-cafe-b1a] ⚠️  B1a interim — F247 KD-7: B1 必须 verified CF Access OAuth 或 verified header-auth',
    );
  });

  function shutdown(signal: NodeJS.Signals): void {
    console.error(`[cat-cafe-b1a] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isEntryPoint = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[cat-cafe-b1a] fatal:', err);
    process.exit(1);
  });
}

// Export for tests
export { redactSecrets, validateB1aEnv, wrapResponseWithRedact };
