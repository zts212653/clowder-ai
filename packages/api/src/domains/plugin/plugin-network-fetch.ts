import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import http from 'node:http';

function bridgeConfig(): { endpoint: URL; token: string } | undefined {
  const value = process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_URL;
  const token = process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_TOKEN;
  if (!value && !token) return undefined;
  if (!value || !token) throw new TypeError('Desktop plugin network bridge configuration is incomplete');
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new TypeError('Desktop plugin network bridge must be an authenticated loopback endpoint');
  }
  return { endpoint, token };
}

function responseHeaders(values: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  return headers;
}

function bridgeResponse(incoming: IncomingMessage, chunks: Buffer[]): Response {
  const status = incoming.statusCode ?? 502;
  const body = status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
  return new Response(body, {
    status,
    statusText: incoming.statusMessage,
    headers: responseHeaders(incoming.headers),
  });
}

async function fetchThroughBridge(target: URL, init: RequestInit, config: { endpoint: URL; token: string }) {
  const body = Buffer.from(JSON.stringify({ url: target.href }), 'utf8');
  return new Promise<Response>((resolve, reject) => {
    const request = http.request(
      new URL('/fetch', config.endpoint),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
          'content-length': String(body.byteLength),
        },
        signal: init.signal ?? undefined,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('error', reject);
        incoming.once('end', () => {
          try {
            resolve(bridgeResponse(incoming, chunks));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

/**
 * Fetches official plugin discovery/package resources.
 * Packaged desktop builds use Electron's loopback bridge so Chromium owns system proxy resolution;
 * source/headless processes keep Node's ordinary explicit proxy environment contract.
 */
export async function fetchPluginNetworkResource(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(String(input));
  const config = bridgeConfig();
  if (config) return fetchThroughBridge(target, init, config);
  // Source/headless deployments intentionally keep Node's explicit environment contract:
  // start Node with NODE_USE_ENV_PROXY=1 and set HTTP(S)_PROXY / NO_PROXY as needed.
  return fetch(target, init);
}
