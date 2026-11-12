import type { IncomingMessage } from 'node:http';
import { Agent, request } from 'node:https';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const MAX_RESPONSE_BYTES = 1024 * 1024;

function quotaResponse(res: IncomingMessage, chunks: Buffer[]) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (value) for (const item of value) headers.append(name, item);
  }
  const status = res.statusCode ?? 502;
  const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
  return new Response(body, { status, headers });
}

function quotaProxyAgent() {
  const proxy = process.env.https_proxy?.trim() || process.env.HTTPS_PROXY?.trim();
  if (!proxy) return undefined;
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 5)) throw new Error('codex_quota_proxy_requires_node_24_5');
  if (!['http:', 'https:'].includes(new URL(proxy).protocol))
    throw new TypeError('codex_quota_proxy_protocol_unsupported');
  const proxyEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  const options = { keepAlive: false, proxyEnv };
  return new Agent(options);
}

/** Only the official read-only quota GET uses this agent; the global dispatcher stays untouched. */
export const fetchCodexQuota: typeof fetch = async (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = init.method ?? (input instanceof Request ? input.method : 'GET');
  if (url !== CODEX_USAGE_URL || method !== 'GET') throw new TypeError('codex_quota_request_not_allowed');
  const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  const deadline = AbortSignal.timeout(8000);
  const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
  const agent = quotaProxyAgent();
  if (!agent) return globalThis.fetch(input, { ...init, method: 'GET', signal, redirect: 'error' });
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  try {
    return await new Promise<Response>((resolve, reject) => {
      const req = request(url, { method: 'GET', headers: Object.fromEntries(headers), agent, signal }, (res) => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          res.destroy();
          reject(new TypeError('codex_quota_redirect_not_allowed'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) res.destroy(new Error('codex_quota_response_too_large'));
          else chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => {
          try {
            resolve(quotaResponse(res, chunks));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.once('error', reject);
      req.end();
    });
  } finally {
    agent.destroy();
  }
};
