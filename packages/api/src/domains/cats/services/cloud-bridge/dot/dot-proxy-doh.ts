import { isIP } from 'node:net';
import {
  createPinnedRequestOptions,
  resolveExternalUrl,
  validateExternalUrl,
} from '../../../../../utils/url-safety.js';
import { dotDohAddresses } from './dot-doh-answer.js';
import { connectDotProxyTls, parseDotProxyUrl, requestOnDotTls } from './dot-proxy-tls.js';
import type { DotWebhookSend } from './dot-webhook.js';

async function withDotPhaseTimeout<T>(
  parent: AbortSignal,
  milliseconds: number,
  reason: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(reason)), milliseconds);
  try {
    return await run(AbortSignal.any([parent, controller.signal]));
  } finally {
    clearTimeout(timer);
  }
}

async function queryDotDoh(proxy: URL, hostname: string, type: 1 | 28, signal: AbortSignal) {
  const socket = await connectDotProxyTls(proxy, 'dns.google:443', 'dns.google', signal);
  const query = new URLSearchParams({ name: hostname, type: String(type), edns_client_subnet: '0.0.0.0/0' });
  const response = await requestOnDotTls(
    socket,
    {
      hostname: 'dns.google',
      servername: 'dns.google',
      path: `/resolve?${query}`,
      method: 'GET',
      headers: { Host: 'dns.google', accept: 'application/dns-json' },
    },
    signal,
  );
  if (response.status !== 200) throw new Error('callback_dns_unavailable');
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    throw new Error('callback_dns_invalid_response');
  }
  return dotDohAddresses(hostname, type, value);
}

async function resolveDotProxyUrl(proxy: URL, url: string, signal: AbortSignal) {
  const dnsController = new AbortController();
  const dnsTimer = setTimeout(() => dnsController.abort(new Error('callback_dns_timeout')), 5000);
  const dnsSignal = AbortSignal.any([signal, dnsController.signal]);
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    let records: { address: string }[];
    if (isIP(hostname)) records = [{ address: hostname }];
    else {
      const answers = await Promise.all(
        ([1, 28] as const).map(async (type) => {
          return queryDotDoh(proxy, hostname, type, dnsSignal);
        }),
      );
      records = answers.flat().map((address) => ({ address }));
      if (!records.length || records.length > 32) throw new Error('callback_dns_invalid_response');
    }
    return await resolveExternalUrl(url, async () => records);
  } catch (error) {
    const dnsExpired = dnsController.signal.aborted;
    // Cancel the other family as well; never leave work running after a parse failure.
    dnsController.abort();
    if (signal.aborted) throw signal.reason;
    if (dnsExpired) throw new Error('callback_dns_timeout');
    throw error;
  } finally {
    clearTimeout(dnsTimer);
    dnsController.abort();
  }
}

/** No global proxy/DNS mutations. Opt-in transport uses only the operator's loopback HTTP proxy. */
export function createProxyDotWebhookSender(rawProxy: string, totalMs = 20_000): DotWebhookSend {
  const proxy = parseDotProxyUrl(rawProxy);
  return async (url, headers, body) => {
    const parsed = validateExternalUrl(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash)
      throw new Error('invalid_callback_url');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('callback_timeout')), totalMs);
    try {
      const resolved = await resolveDotProxyUrl(proxy, url, controller.signal);
      controller.signal.throwIfAborted();
      const port = resolved.url.port || '443';
      const authority = `${isIP(resolved.address) === 6 ? `[${resolved.address}]` : resolved.address}:${port}`;
      const socket = await withDotPhaseTimeout(controller.signal, 5000, 'callback_connect_timeout', (signal) =>
        connectDotProxyTls(proxy, authority, resolved.hostname, signal),
      );
      const options = createPinnedRequestOptions(resolved);
      options.method = 'POST';
      options.headers = { ...headers, ...options.headers };
      return await withDotPhaseTimeout(controller.signal, 10_000, 'callback_response_timeout', (signal) =>
        requestOnDotTls(socket, options, signal, body),
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
