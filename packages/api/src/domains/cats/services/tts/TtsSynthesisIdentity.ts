import {
  fetchServiceHealth,
  getServiceManifest,
  normalizeTtsModelId,
  type ServiceHealthResult,
  serviceHealthIdentityMatches,
} from '../../../services/service-manifest.js';
import { TtsCacheIdentityError } from './TtsCacheIdentityError.js';
import { beginTtsIdentityObservation, readCachedTtsIdentity, recordTtsIdentity } from './TtsIdentityCache.js';

// Narrow migration compatibility for the original unprofiled backends/defaults.
// An arbitrary repo ID or local path is not evidence of its loaded architecture.
const legacyCacheModels = new Set(['qwen3-clone', 'mlx-audio', 'edge-tts', 'sapi', 'piper'].map(normalizeTtsModelId));

export interface TtsSynthesisIdentity {
  readonly model: string;
  readonly generationProfile: string | null;
  readonly cacheOnly: boolean;
}

export function readGenerationProfile(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) throw new Error('Invalid TTS generation profile');
  return value;
}

function verifyHealth(health: ServiceHealthResult, model: string): void {
  const service = getServiceManifest('mlx-tts');
  if (!service) throw new Error('TTS service manifest is unavailable');
  const identity = serviceHealthIdentityMatches(service, { enabled: true, selectedModel: model }, health);
  if (!health.ok || !identity.matches) {
    throw new Error(`TTS model verification failed: ${health.error ?? identity.reason ?? 'unknown model'}`);
  }
}

export async function prepareTtsIdentity(
  baseUrl: string,
  selectedModel: string | undefined,
  cacheDir?: string,
): Promise<TtsSynthesisIdentity> {
  const observation = cacheDir ? await beginTtsIdentityObservation(cacheDir, baseUrl) : undefined;
  const service = getServiceManifest('mlx-tts');
  if (!service) throw new Error('TTS service manifest is unavailable');
  const health = await fetchServiceHealth(`${baseUrl}/health`, service);
  if (!health.ok && cacheDir) {
    const advertised =
      health.details?.model && health.details.model !== 'none' ? health.details.model : health.details?.backend;
    if (
      selectedModel &&
      typeof advertised === 'string' &&
      advertised !== 'none' &&
      normalizeTtsModelId(advertised) !== normalizeTtsModelId(selectedModel)
    ) {
      throw new Error('TTS model verification failed: conflicting offline health identity');
    }
    const receipt = readCachedTtsIdentity(cacheDir, baseUrl);
    if (receipt) {
      if (selectedModel && normalizeTtsModelId(receipt.model) !== normalizeTtsModelId(selectedModel)) {
        throw new Error('Cached TTS identity differs from the selected model');
      }
      return { model: receipt.model, generationProfile: receipt.generationProfile, cacheOnly: true };
    }
    // Only evidenced legacy models may probe their pre-profile namespace.
    // Unknown/custom models need a live observation, regardless of their name.
    if (selectedModel && legacyCacheModels.has(normalizeTtsModelId(selectedModel))) {
      return { model: selectedModel, generationProfile: null, cacheOnly: true };
    }
    if (selectedModel)
      throw new TtsCacheIdentityError(
        'TTS_CACHE_IDENTITY_UNKNOWN',
        'TTS generation policy is unknown without a verified cache receipt; reconnect TTS to verify it',
      );
  }
  let model = selectedModel;
  if (model === undefined) {
    const actual = health.details?.model;
    const identity = actual && actual !== 'none' ? actual : health.details?.backend;
    if (!health.ok || typeof identity !== 'string' || !identity)
      throw new Error('TTS legacy model identity could not be discovered');
    model = normalizeTtsModelId(identity);
  }
  verifyHealth(health, model);
  const identity = {
    model,
    generationProfile: readGenerationProfile(health.details?.generation_profile),
    cacheOnly: false,
  };
  if (observation) recordTtsIdentity(observation, identity);
  return identity;
}

export async function verifyTtsIdentity(baseUrl: string, model: string, profile: string | null): Promise<void> {
  const service = getServiceManifest('mlx-tts');
  if (!service) throw new Error('TTS service manifest is unavailable');
  const health = await fetchServiceHealth(`${baseUrl}/health`, service);
  verifyHealth(health, model);
  if (readGenerationProfile(health.details?.generation_profile) !== profile) {
    throw new Error('TTS generation profile changed; prepare synthesis again');
  }
}

export async function verifyTtsResponse(response: Response, profile: string | null): Promise<void> {
  if ((response.headers.get('x-tts-generation-profile') || null) !== profile) {
    await response.body?.cancel();
    throw new Error('TTS generation profile changed in synthesis response; prepare synthesis again');
  }
}
