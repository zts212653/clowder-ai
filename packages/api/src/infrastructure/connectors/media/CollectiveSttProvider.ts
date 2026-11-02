import type { CollectiveAudioTranscriber } from '../../../domains/collaborative-content/collective-artifact/message-model-av.js';
import { getServiceConfig } from '../../../domains/services/service-config.js';
import {
  fetchServiceHealth,
  getServiceManifest,
  PORT_ENV_VARS,
  parseServicePort,
  resolveEffectiveServiceConfig,
  resolveServiceEndpoint,
  resolveServiceHealthUrl,
  type ServiceConfig,
  serviceHealthIdentityMatches,
} from '../../../domains/services/service-manifest.js';
import { WhisperSttProvider } from './WhisperSttProvider.js';

/** Uses only this Host's explicitly pinned, enabled and healthy service. It starts/configures no service. */
export function createConfiguredCollectiveTranscriber(
  options: {
    getConfig?: () => ServiceConfig | undefined;
    getEnv?: () => NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): CollectiveAudioTranscriber {
  const choose = () => {
    const manifest = getServiceManifest('whisper-stt');
    if (!manifest) return undefined;
    const env = options.getEnv?.() ?? process.env;
    const config = resolveEffectiveServiceConfig(
      manifest,
      (options.getConfig ?? (() => getServiceConfig('whisper-stt')))(),
      env,
    );
    if (!config?.enabled || config.installed === false) return undefined;
    const pinned =
      parseServicePort(config.port === undefined ? undefined : String(config.port)) !== null ||
      parseServicePort(env[PORT_ENV_VARS['whisper-stt']]) !== null ||
      manifest.endpointEnvVars.some((key) => Boolean(env[key]?.trim()));
    if (!pinned) return undefined;
    const endpoint = resolveServiceEndpoint(manifest, env, config);
    if (!endpoint) return undefined;
    try {
      const url = new URL(endpoint);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return undefined;
      return { endpoint, manifest, config, key: JSON.stringify([endpoint, config.selectedModel]) };
    } catch {
      return undefined;
    }
  };
  return async (request) => {
    request.signal.throwIfAborted();
    const chosen = choose();
    if (!chosen) return undefined;
    const transport: typeof fetch = (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== new URL(chosen.endpoint).origin) throw new Error('Speech transport left the selected Host');
      return (options.fetchImpl ?? fetch)(input, {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.any([request.signal, ...(init?.signal ? [init.signal] : [])]),
      });
    };
    const health = await fetchServiceHealth(
      resolveServiceHealthUrl(chosen.manifest, chosen.endpoint),
      chosen.manifest,
      transport,
    );
    if (
      !health.ok ||
      !serviceHealthIdentityMatches(chosen.manifest, chosen.config, health).matches ||
      choose()?.key !== chosen.key
    )
      return undefined;
    const provider = new WhisperSttProvider({
      baseUrl: chosen.endpoint,
      model: chosen.config.selectedModel,
      _fetchFn: transport,
    });
    const result = await provider.transcribe(request);
    request.signal.throwIfAborted();
    if (choose()?.key !== chosen.key) return undefined;
    if (typeof result.text !== 'string') throw new Error('The configured speech service returned no transcript');
    return { text: result.text, provider: provider.id };
  };
}
