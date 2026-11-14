import type { IncomingMessage } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

function platformResponse(incoming: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, values] of Object.entries(incoming.headers)) {
    if (Array.isArray(values)) for (const value of values) headers.append(name, value);
    else if (values !== undefined) headers.set(name, values);
  }
  const status = incoming.statusCode ?? 502;
  const noBody = [204, 205, 304].includes(status);
  if (noBody) incoming.resume();
  return new Response(noBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), { status, headers });
}

/** Node's existing proxyEnv agent path, scoped to this call; no global dispatcher or sidecar. */
export const platformHttpFetch: typeof fetch = async (input, init = {}) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== 'https:') throw new Error('Platform transport requires HTTPS');
  const proxyEnv = { ...process.env };
  const all = proxyEnv.all_proxy ?? proxyEnv.ALL_PROXY;
  if (all && !proxyEnv.https_proxy && !proxyEnv.HTTPS_PROXY) proxyEnv.HTTPS_PROXY = all;
  const proxy = proxyEnv.https_proxy ?? proxyEnv.HTTPS_PROXY;
  if (proxy) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 5)) throw new Error('Platform proxy requires Node 24.5');
    if (!['http:', 'https:'].includes(new URL(proxy).protocol)) throw new Error('Platform proxy protocol unsupported');
  }
  const options = { keepAlive: false, proxyEnv };
  const agent = new Agent(options);
  return new Promise<Response>((resolve, reject) => {
    const outgoing = httpsRequest(
      url,
      {
        agent,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        signal: request.signal,
      },
      (incoming) => {
        incoming.once('close', () => agent.destroy());
        incoming.once('error', () => agent.destroy());
        // Redirects are returned as their real non-2xx response, never followed with authentication.
        resolve(platformResponse(incoming));
      },
    );
    outgoing.once('error', (error) => {
      agent.destroy();
      reject(error);
    });
    if (request.body) {
      const source = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream<Uint8Array>);
      source.once('error', (error) => outgoing.destroy(error));
      outgoing.once('close', () => source.destroy());
      source.pipe(outgoing);
    } else outgoing.end();
  });
};

/** One transport injection point for production compositions and their contract tests. */
export const platformHttpTransport = { fetch: platformHttpFetch };
