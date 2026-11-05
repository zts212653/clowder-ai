import type { IncomingMessage, ServerResponse } from 'node:http';

const PLUGIN_TOKEN = /^cpa_[A-Za-z0-9_-]{43}$/;
const LEGACY_DOT_TOKEN = /^[a-f0-9]{64}$/;

async function readBoundedHostResponse(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('plugin_response_too_large');
      chunks.push(result.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Public transport for an installed plugin's fixed request port. The bearer token is the only
 * selector: the remote listener does not know the plugin id, contribution id, or package method.
 */
export async function handlePluginRemoteRequest(req: IncomingMessage, res: ServerResponse, apiBase: string) {
  const target = new URL(apiBase);
  if (
    target.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.username ||
    target.password
  ) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'plugin_host_unavailable' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    res.end();
    return;
  }
  const requestUrl = new URL(req.url ?? '/', 'http://localhost');
  const legacyDotPath = requestUrl.pathname === '/dot/mcp';
  const bearer = legacyDotPath
    ? (requestUrl.searchParams.get('token') ?? undefined)
    : /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
  const validToken = bearer !== undefined && (PLUGIN_TOKEN.test(bearer) || LEGACY_DOT_TOKEN.test(bearer));
  if (
    !validToken ||
    (legacyDotPath && !LEGACY_DOT_TOKEN.test(bearer)) ||
    (!legacyDotPath && requestUrl.searchParams.has('token'))
  ) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'plugin_authentication_required' }));
    return;
  }
  if (
    !String(req.headers['content-type'] ?? '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    res.writeHead(415);
    res.end();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 15 * 1024 * 1024) {
        res.writeHead(413);
        res.end();
        return;
      }
      chunks.push(bytes);
    }
    const response = await fetch(new URL('/api/plugin-runtime/handle', target), {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: Buffer.concat(chunks),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readBoundedHostResponse(response);
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'plugin_host_unavailable' }));
  }
}
