import http, { type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import type { Socket } from 'node:net';
import tls from 'node:tls';

export function parseDotProxyUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid_dot_proxy_url: CAT_CAFE_DOT_WEBHOOK_PROXY_URL');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('invalid_dot_proxy_url: CAT_CAFE_DOT_WEBHOOK_PROXY_URL');
  return url;
}

export async function connectDotProxyTls(proxy: URL, authority: string, hostname: string, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    let socket: Socket | undefined;
    let secure: tls.TLSSocket | undefined;
    const request = http.request({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority },
      agent: false,
      signal,
    });
    const abort = () => {
      request.destroy();
      socket?.destroy();
      secure?.destroy();
      reject(signal.reason);
    };
    const fail = (error: Error) => {
      signal.removeEventListener('abort', abort);
      request.destroy();
      socket?.destroy();
      secure?.destroy();
      reject(error);
    };
    signal.addEventListener('abort', abort, { once: true });
    request.once('error', fail);
    request.once('connect', (response, connected, head) => {
      socket = connected;
      if (signal.aborted) {
        abort();
        return;
      }
      if (response.statusCode !== 200 || head.length) {
        fail(new Error('callback_proxy_connect_failed'));
        return;
      }
      secure = tls.connect({
        socket: connected,
        host: hostname,
        servername: hostname,
        rejectUnauthorized: true,
        checkServerIdentity: tls.checkServerIdentity,
      });
      secure.once('error', fail);
      secure.once('secureConnect', () => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          abort();
          return;
        }
        // The request below owns the socket after handoff; never re-resolve a hostname.
        resolve(secure as tls.TLSSocket);
      });
    });
    request.end();
  });
}

/** A single-use Agent can supply only this verified TLS socket, never open a replacement. */
export async function requestOnDotTls(
  socket: tls.TLSSocket,
  options: RequestOptions,
  signal: AbortSignal,
  body?: string,
): Promise<{ status: number; body: string }> {
  const agent = new https.Agent({ keepAlive: false });
  let supplied = false;
  agent.createConnection = () => {
    if (supplied || socket.destroyed) throw new Error('callback_socket_unavailable');
    supplied = true;
    return socket;
  };
  try {
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const request = https.request({ ...options, agent, signal }, (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 64 * 1024) {
            request.destroy(new Error('callback_response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('callback_response_aborted')));
      });
      request.once('error', reject);
      request.end(body);
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    agent.destroy();
    socket.destroy();
  }
}
