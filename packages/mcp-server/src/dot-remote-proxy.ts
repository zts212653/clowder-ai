import type { IncomingMessage, ServerResponse } from 'node:http';

async function readBoundedHostResponse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('dot_response_too_large');
      chunks.push(result.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The existing remote listener carries Dot to its separately authenticated Host
 * endpoint. It never selects a cat, borrows Pro credentials, or accepts a target URL. */
export async function handleDotRemoteRequest(req: IncomingMessage, res: ServerResponse, apiBase: string) {
  const target = new URL(apiBase);
  if (
    target.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.username ||
    target.password
  ) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: 'dot_host_unavailable' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    res.end();
    return;
  }
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const bearer = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization ?? ''))?.[1];
  const tokens = query.getAll('token');
  const secret = bearer ?? (tokens.length === 1 ? tokens[0] : undefined);
  if (
    !secret ||
    !/^[a-f0-9]{64}$/.test(secret) ||
    tokens.length > 1 ||
    (bearer && tokens.length && bearer !== tokens[0])
  ) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'dot_authentication_required' }));
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
    const response = await fetch(new URL('/api/plugins/chatgpt-dot/mcp', target), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: Buffer.concat(chunks),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    // Host methods emit bounded context/metadata, never raw images or secrets.
    const body = await readBoundedHostResponse(response);
    res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'dot_host_unavailable' }));
  }
}
