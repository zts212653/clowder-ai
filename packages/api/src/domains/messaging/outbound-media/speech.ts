/**
 * F202 W2-5b — outbound speech for text-only audio blocks, on the existing listen-asset cache.
 *
 * Voice mode stores audio blocks as text only; the browser synthesizes them into temporary blobs
 * no connector can use, so the Host synthesizes them for outbound delivery. The listen-asset
 * service already gives a content-addressed cache, shared in-flight synthesis and atomic writes;
 * the caller owns the time budget (the service's plain-synthesis path cannot be aborted).
 */
import { join } from 'node:path';
import { ListenAssetService } from '../../cats/services/tts/ListenAssetService.js';
import type { TtsRegistry } from '../../cats/services/tts/TtsRegistry.js';
import type { OutboundSpeechSynthesizer } from './publication.js';

export function createListenAssetSpeech(
  registry: TtsRegistry,
  cacheDir: string,
): OutboundSpeechSynthesizer & { close(): Promise<void> } {
  const assets = new ListenAssetService(registry, cacheDir);
  return {
    async synthesize(text, voice, signal) {
      const asset = await assets.getOrCreate(text, {
        synthesis: voice.catId === undefined ? {} : { catId: voice.catId },
        signal,
      });
      return { path: join(cacheDir, asset.assetId) };
    },
    close: () => assets.close(),
  };
}
