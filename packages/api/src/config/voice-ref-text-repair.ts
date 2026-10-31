import { readFileSync } from 'node:fs';

/**
 * Known reference-clip transcripts that were shipped wrong in the template and seeded into
 * runtime catalogs. A clone voice given a transcript its clip does not say speaks that text
 * first and turns the rest into gibberish.
 *
 * Each entry is an exact (clip, wrong transcript) pair. Only that pair is rewritten, so a
 * transcript a user changed on purpose is never touched.
 */
const KNOWN_REF_TEXT_CORRECTIONS: ReadonlyArray<{ clip: string; wrong: string; correct: string }> = [
  {
    // 2026-10-05: the clip says this line (its .lab file and Whisper agree); the template had
    // paired it with 「晚上好！今天的冒险怎么样？」 since F066.
    clip: 'genshin/班尼特/vo_bennett_dialog_greetingNight.wav',
    wrong: '晚上好！今天的冒险怎么样？',
    correct: '要不要陪我去和老爹们聊聊天啊？老冒险家的故事可有意思了！',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repairVoiceConfig(voiceConfig: unknown): boolean {
  if (!isRecord(voiceConfig)) return false;
  const fix = KNOWN_REF_TEXT_CORRECTIONS.find(
    (entry) => voiceConfig.refAudio === entry.clip && voiceConfig.refText === entry.wrong,
  );
  if (!fix) return false;
  voiceConfig.refText = fix.correct;
  return true;
}

/**
 * Rewrite known-wrong reference transcripts in a runtime catalog. Returns the repaired JSON text,
 * or null when nothing needed to change (the caller then leaves the file as it is).
 */
export function repairKnownVoiceRefTexts(catalogRaw: string): string | null {
  const catalog = JSON.parse(catalogRaw) as { breeds?: unknown };
  if (!Array.isArray(catalog.breeds)) return null;
  let dirty = false;
  for (const breed of catalog.breeds) {
    if (!isRecord(breed)) continue;
    if (repairVoiceConfig(breed.voiceConfig)) dirty = true;
    const variants = Array.isArray(breed.variants) ? breed.variants : [];
    for (const variant of variants) {
      if (isRecord(variant) && repairVoiceConfig(variant.voiceConfig)) dirty = true;
    }
  }
  return dirty ? `${JSON.stringify(catalog, null, 2)}\n` : null;
}

/** Read a catalog file and return its repaired text, or null if it is unreadable or already correct. */
export function readRepairedVoiceRefTexts(catalogPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf-8');
  } catch {
    return null;
  }
  return repairKnownVoiceRefTexts(raw);
}
