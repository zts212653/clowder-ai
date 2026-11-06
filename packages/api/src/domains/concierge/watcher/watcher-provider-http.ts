import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

/** Each bounded role retains the exact launch's proxy policy; no process-global dispatcher or new credentials. */
export function watcherProviderHttp(upstream: URL, transportEnv: Readonly<Record<string, string>>) {
  const proxyEnv = { ...transportEnv };
  const all = proxyEnv.all_proxy ?? proxyEnv.ALL_PROXY;
  if (all && !proxyEnv.http_proxy && !proxyEnv.HTTP_PROXY) proxyEnv.HTTP_PROXY = all;
  if (all && !proxyEnv.https_proxy && !proxyEnv.HTTPS_PROXY) proxyEnv.HTTPS_PROXY = all;
  const proxy =
    upstream.protocol === 'https:'
      ? (proxyEnv.https_proxy ?? proxyEnv.HTTPS_PROXY)
      : (proxyEnv.http_proxy ?? proxyEnv.HTTP_PROXY);
  if (proxy) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major! < 24 || (major === 24 && minor! < 5)) throw new Error('watcher_provider_proxy_requires_node_24_5');
    if (!['http:', 'https:'].includes(new URL(proxy).protocol))
      throw new Error('watcher_provider_proxy_protocol_unsupported');
  }
  const options = { keepAlive: true, proxyEnv };
  const agent = upstream.protocol === 'https:' ? new HttpsAgent(options) : new HttpAgent(options);
  return {
    send(url: URL, headers: Headers, body: string, signal: AbortSignal): Promise<IncomingMessage> {
      return new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          { method: 'POST', headers: Object.fromEntries(headers), agent, signal },
          resolve,
        );
        request.once('error', reject);
        request.end(body);
      });
    },
    close() {
      agent.destroy();
    },
  };
}
