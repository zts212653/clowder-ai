/** One URL boundary for direct provider calls; never concatenate query strings or version segments. */
import type { AccountProtocol } from '@cat-cafe/shared';

export const PROVIDER_BASE_URLS: Readonly<Record<AccountProtocol, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  'openai-responses': 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
  kimi: 'https://api.moonshot.ai',
};

export function parseProviderBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error('Provider base URL must be an absolute HTTP(S) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Provider base URL must use HTTP(S)');
  }
  return url;
}

interface ProviderEndpointOptions {
  protocol: AccountProtocol;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export function buildProviderEndpoint({ protocol, baseUrl, model, apiKey }: ProviderEndpointOptions): string {
  const url = parseProviderBaseUrl(baseUrl ?? PROVIDER_BASE_URLS[protocol]);
  let resource: string;
  if (protocol === 'google') {
    if (!model?.trim()) throw new Error('Google endpoint requires a model');
    resource = `models/${encodeURIComponent(model.trim())}:generateContent`;
    if (apiKey !== undefined) url.searchParams.set('key', apiKey);
  } else {
    resource =
      protocol === 'anthropic' ? 'messages' : protocol === 'openai-responses' ? 'responses' : 'chat/completions';
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith(`/${resource}`)) {
    const version = /\/v\d+(?:alpha|beta)?$/.test(path) ? '' : protocol === 'google' ? '/v1beta' : '/v1';
    url.pathname = `${path}${version}/${resource}`;
  }
  return url.href;
}
