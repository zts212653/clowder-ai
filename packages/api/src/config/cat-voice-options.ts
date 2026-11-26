import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import type { CatBreed, CatVoiceOption } from '@cat-cafe/shared';
import { loadCatConfig, resolveRuntimeCatTemplatePath } from './cat-config-loader.js';

function breedOptions(breed: CatBreed): CatVoiceOption[] {
  return breed.variants.flatMap((variant) => {
    const voice = variant.voiceConfig;
    return voice
      ? [
          {
            id: `${breed.id}:voice:${createHash('sha256')
              .update(
                JSON.stringify([
                  voice.voice,
                  voice.langCode,
                  voice.speed,
                  voice.refAudio,
                  voice.refText,
                  voice.instruct,
                  voice.temperature,
                ]),
              )
              .digest('hex')}`,
            label: voice.refAudio ? basename(dirname(voice.refAudio)) : voice.voice,
            familyId: breed.id,
            familyName: breed.displayName ?? breed.name,
            sourceCatId: variant.catId ?? breed.catId,
            voiceConfig: { ...voice },
            available: true,
            ...(voice.refAudio ? { referenceAvailability: 'unknown' as const } : {}),
          },
        ]
      : [];
  });
}

/** Existing saved/template voices only. Never assigns a voice or infers a new member's family. */
export function getCatVoiceOptions(): CatVoiceOption[] {
  const configs = [loadCatConfig(), loadCatConfig(resolveRuntimeCatTemplatePath())];
  const seen = new Set<string>();
  return configs
    .flatMap((config) => config.breeds.flatMap(breedOptions))
    .filter((choice) => {
      const key = choice.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
