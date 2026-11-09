import { resolveOpenAIPlatformAccount } from '../../../config/account-resolver.js';
import { assertPlatformAccountDestination, platformAccountBaseUrl } from '../../../config/platform-authentication.js';
import { type DecisionRequest, parseDecisionResponse, validateDecisionRequest } from './decisions.js';
import { platformHttpTransport } from './http-transport.js';

function abortable<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(new Error('OpenAI Platform request cancelled'));
    signal.addEventListener('abort', cancelled, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
    if (signal.aborted) cancelled();
  });
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error('OpenAI Platform response unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await abortable(signal, reader.read());
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1_048_576) throw new Error('OpenAI Platform response exceeds bound');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Server-only credentials; each call reads the canonical account and validates its actual destination. */
export function createOpenAIPlatformClient(options: {
  projectRoot: string;
  accountRef?: string;
  fetch?: typeof fetch;
}) {
  return {
    async decide(request: DecisionRequest, context: { signal?: AbortSignal } = {}) {
      validateDecisionRequest(request);
      const signal = AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(4_500)]);
      signal.throwIfAborted();
      const profile = resolveOpenAIPlatformAccount(options.projectRoot, options.accountRef);
      if (!profile?.apiKey?.trim() || /[\r\n]/u.test(profile.apiKey))
        throw new Error('OpenAI Platform credential unavailable');
      const url = platformAccountBaseUrl(profile, 'openai');
      if (url.search || url.hash) throw new Error('OpenAI Platform endpoint must not contain query or fragment');
      const path = url.pathname.replace(/\/+$/, '');
      url.pathname = `${path}${/\/v\d+$/.test(path) ? '' : '/v1'}/decisions`;
      assertPlatformAccountDestination(profile, 'openai', url.href);
      try {
        const response = await abortable(
          signal,
          (options.fetch ?? platformHttpTransport.fetch)(url.href, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: { authorization: `Bearer ${profile.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify(request),
          }),
        );
        const result = parseDecisionResponse(await boundedJson(response, signal), request);
        signal.throwIfAborted();
        return {
          ...result,
          accountRef: profile.id,
          providerRequestId: response.headers.get('x-request-id')?.slice(0, 160) ?? null,
        };
      } catch {
        throw new Error('OpenAI Decisions request unconfirmed');
      }
    },
  };
}
