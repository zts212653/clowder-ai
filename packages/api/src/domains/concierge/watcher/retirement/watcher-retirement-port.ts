import type { BoundedWatcherRunPort } from '../../../cats/services/agents/providers/BoundedWatcherRunPort.js';
import { asCodexAppServerRecord } from '../../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import { watcherProviderOverrides } from '../watcher-provider-config.js';
import { createWatcherRequestBoundary } from '../watcher-request-boundary.js';
import { watcherToolSurface } from '../watcher-surface.js';

/** Exact resume and read/revert only. Even an accidental turn cannot forward a model request. */
export function watcherRetirementPort(signal: AbortSignal, beforeTurn: BoundedWatcherRunPort['beforeTurn']) {
  let boundary: Awaited<ReturnType<typeof createWatcherRequestBoundary>> | undefined;
  const forbidden = async (): Promise<never> => {
    throw new Error('watcher_retirement_model_or_tool_forbidden');
  };
  const port: BoundedWatcherRunPort = {
    instructions: '',
    tools: [],
    config: watcherToolSurface({}).config,
    outputSchema: { type: 'object', properties: {}, additionalProperties: false },
    callTool: forbidden,
    accepted: forbidden,
    completed: forbidden,
    beforeTurn,
    configureProvider: async ({ config, account, transportEnv }) => {
      const id = typeof config.model_provider === 'string' ? config.model_provider : 'openai';
      const provider = asCodexAppServerRecord(asCodexAppServerRecord(config.model_providers)?.[id]);
      const ownedOpenai = id === 'openai' || id === 'openai_https';
      const upstream =
        typeof provider?.base_url === 'string'
          ? provider.base_url
          : ownedOpenai && account?.type === 'chatgpt'
            ? 'https://chatgpt.com/backend-api/codex'
            : ownedOpenai && account?.type === 'apiKey'
              ? 'https://api.openai.com/v1'
              : undefined;
      if (!upstream) throw new Error('watcher_native_provider_endpoint_unavailable');
      boundary = await createWatcherRequestBoundary(upstream, { signal, transportEnv, controlOnly: true });
      return {
        model_provider: id,
        model_providers: {
          [id]: {
            ...watcherProviderOverrides(
              provider ?? { name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true },
            ),
            base_url: boundary.baseUrl,
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
        features: { enable_request_compression: false },
      };
    },
  };
  return { port, close: async () => boundary?.close() };
}
