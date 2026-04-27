/**
 * F34/F066/F103: Cat Voice Configuration
 * Per-cat TTS voice settings, mirroring cat-budgets.ts pattern.
 *
 * Priority: env var override > resolved runtime cat config voiceConfig > hardcoded defaults (by breedId)
 *
 * F103: Each cat (not each breed) has independent voice config in the resolved runtime cat config.
 * loadVoicesFromJson() iterates ALL variants, keyed by catId — same pattern as avatar/color.
 * Hardcoded breed defaults remain as fallback for cats without explicit voiceConfig.
 *
 * Env vars:
 *   GENSHIN_VOICE_DIR     → base dir for genshin reference audio
 *   CAT_OPUS_TTS_VOICE    → per-cat voice ID override (legacy)
 *   CAT_CODEX_TTS_VOICE   → per-cat voice ID override (legacy)
 *   CAT_GEMINI_TTS_VOICE  → per-cat voice ID override (legacy)
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { VoiceConfig } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { resolveBreedId } from './breed-resolver.js';
import { getAllCatIdsFromConfig, loadCatConfig } from './cat-config-loader.js';

const VOICE_ENV_KEYS = {
  opus: 'CAT_OPUS_TTS_VOICE',
  codex: 'CAT_CODEX_TTS_VOICE',
  gemini: 'CAT_GEMINI_TTS_VOICE',
} as const;

/**
 * Base directory for Genshin reference audio files.
 * Override with GENSHIN_VOICE_DIR env var.
 */
function genshinVoiceDir(): string {
  return process.env.GENSHIN_VOICE_DIR ?? join(homedir(), 'projects/relay-station/GPT-SoVITS/character-models/genshin');
}

/**
 * F103: Base directory for all character voice models (parent of genshin/ and honkai-starrail/).
 * Priority: CHARACTER_VOICE_DIR > dirname(GENSHIN_VOICE_DIR) > hardcoded default.
 * This ensures backward compat: users who only set GENSHIN_VOICE_DIR still get correct paths.
 */
function characterVoiceBaseDir(): string {
  if (process.env.CHARACTER_VOICE_DIR) return process.env.CHARACTER_VOICE_DIR;
  if (process.env.GENSHIN_VOICE_DIR) return dirname(process.env.GENSHIN_VOICE_DIR);
  return join(homedir(), 'projects/relay-station/GPT-SoVITS/character-models');
}

/**
 * Hardcoded defaults — keyed by breedId so all variants share the same voice.
 *
 * F066 E-type unified scheme: Qwen3-TTS Base clone with Genshin character refs.
 * voice IDs are Kokoro-compatible (zm_yunjian) for mlx-audio fallback;
 * clone mode (qwen3-clone provider) ignores voice and uses refAudio instead.
 *   宪宪 → 流浪者 (Wanderer): 调皮狡黠、得意戏弄
 *   砚砚 → 魈 (Xiao): 傲娇冰山、表面严厉实际关心
 *   烁烁 → 班尼特 (Bennett): 阳光开心、充满热情兴奋
 */
function buildDefaultVoices(): Record<string, VoiceConfig> {
  const base = genshinVoiceDir();
  return {
    ragdoll: {
      voice: 'zm_yunjian',
      langCode: 'zh',
      speed: 1.0,
      refAudio: join(base, '流浪者/vo_wanderer_dialog_greetingMorning.wav'),
      refText: '快醒醒，太阳要晒屁股咯。哈，你不会以为我会这么叫你起床吧？',
      instruct: '用一个调皮狡黠的少年语气说话，带着得意和戏弄',
      temperature: 0.3,
    },
    'maine-coon': {
      voice: 'zm_yunjian',
      langCode: 'zh',
      speed: 1.0,
      refAudio: join(base, '魈/vo_xiao_dialog_close2.wav'),
      refText: '别被污染，我不会留情的。我是说，既然是你，你应该能够保持坚定。',
      instruct: '用一个傲娇冰山少年的语气说话，表面严厉实际关心',
      temperature: 0.3,
    },
    siamese: {
      voice: 'zm_yunjian',
      langCode: 'zh',
      speed: 1.0,
      refAudio: join(base, '班尼特/vo_bennett_dialog_greetingNight.wav'),
      refText: '晚上好！今天的冒险怎么样？',
      instruct: '用一个超级阳光开心的小男孩语气说话，充满热情和兴奋',
      temperature: 0.3,
    },
  };
}

/** Conservative fallback for unknown/dynamic cats */
const GLOBAL_FALLBACK_VOICE: VoiceConfig = {
  voice: 'zm_yunjian',
  langCode: 'zh',
  speed: 1.0,
};

// Lazily built default voices (avoids calling homedir() at import time in tests)
let defaultVoices: Record<string, VoiceConfig> | null = null;
function getDefaultVoices(): Record<string, VoiceConfig> {
  if (!defaultVoices) defaultVoices = buildDefaultVoices();
  return defaultVoices;
}

// Cache from resolved runtime cat config
let cachedJsonVoices: Record<string, VoiceConfig> | null = null;

/**
 * F103: Load per-catId voices from all variants (not just breed defaults).
 * Each variant's catId gets its own voice config — same pattern as avatar/color.
 *
 * Relative refAudio paths (not starting with /) are resolved against CHARACTER_VOICE_DIR.
 * This lets cat-template.json / runtime catalog use clean paths like "genshin/流浪者/xxx.wav".
 */
function loadVoicesFromJson(): Record<string, VoiceConfig> {
  if (cachedJsonVoices) return cachedJsonVoices;

  try {
    const config = loadCatConfig();
    const baseDir = characterVoiceBaseDir();
    cachedJsonVoices = {};
    for (const breed of config.breeds) {
      for (const variant of breed.variants) {
        if (variant.voiceConfig) {
          const catId = variant.catId ?? breed.catId;
          const vc = variant.voiceConfig;
          cachedJsonVoices[catId] =
            vc.refAudio && !isAbsolute(vc.refAudio) ? { ...vc, refAudio: join(baseDir, vc.refAudio) } : vc;
        }
      }
    }
    return cachedJsonVoices;
  } catch {
    cachedJsonVoices = {};
    return cachedJsonVoices;
  }
}

/**
 * Get TTS voice config for a cat.
 * Priority: env var override (voice only) > resolved runtime cat config > hardcoded defaults (by breedId)
 */
export function getCatVoice(catName: string): VoiceConfig {
  // 1. Get base voice from JSON or default (resolve breedId for DEFAULT_VOICES)
  const jsonVoices = loadVoicesFromJson();
  const breedId = resolveBreedId(catName);
  const defaults = getDefaultVoices();
  const baseVoice: VoiceConfig =
    jsonVoices[catName] ?? (breedId ? defaults[breedId] : undefined) ?? defaults[catName] ?? GLOBAL_FALLBACK_VOICE;

  // 2. Check for per-cat env var override (voice ID only)
  const perCatEnvKey = VOICE_ENV_KEYS[catName as keyof typeof VOICE_ENV_KEYS];
  const perCatEnvValue = process.env[perCatEnvKey];
  if (perCatEnvValue?.trim()) {
    return {
      ...baseVoice,
      voice: perCatEnvValue.trim(),
    };
  }

  return baseVoice;
}

/**
 * Get all cat voices (for diagnostics/display)
 */
export function getAllCatVoices(): Record<string, VoiceConfig> {
  const result: Record<string, VoiceConfig> = {};
  // F032 P2: use dynamic config fallback instead of hardcoded cat names
  const registryIds = catRegistry.getAllIds();
  const allIds = registryIds.length > 0 ? registryIds.map(String) : getAllCatIdsFromConfig();
  for (const catName of allIds) {
    result[catName] = getCatVoice(catName);
  }
  return result;
}

/** Clear cached voices (for testing) */
export function clearVoiceCache(): void {
  cachedJsonVoices = null;
  defaultVoices = null;
}
