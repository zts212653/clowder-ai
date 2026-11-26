import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clearVoiceCache } from '../../dist/config/cat-voices.js';

/** Real default clone configs, readable isolated bytes, no formal catalog overlay. */
export function configureReferenceFixture(root) {
  const keys = ['CAT_TEMPLATE_PATH', 'CAT_CAFE_CONFIG_ROOT', 'CHARACTER_VOICE_DIR', 'GENSHIN_VOICE_DIR'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const template = JSON.parse(readFileSync(process.env.CAT_TEMPLATE_PATH, 'utf8'));
  const library = join(root, 'reference-library');
  for (const breed of template.breeds)
    for (const variant of breed.variants) {
      const voice = variant.voiceConfig;
      if (!voice?.refAudio) continue;
      const relative = voice.refAudio.replace(/^.*?(?=genshin\/|honkai-starrail\/)/, '');
      if (relative.startsWith('/')) throw new Error('Fixture references must remain in the isolated library');
      const reference = join(library, relative);
      mkdirSync(dirname(reference), { recursive: true });
      writeFileSync(reference, 'reference-audio-fixture');
      voice.refAudio = reference;
    }
  process.env.CAT_TEMPLATE_PATH = join(root, `cat-template-${process.pid}.json`);
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  process.env.CHARACTER_VOICE_DIR = library;
  process.env.GENSHIN_VOICE_DIR = join(library, 'genshin');
  writeFileSync(process.env.CAT_TEMPLATE_PATH, JSON.stringify(template));
  clearVoiceCache();
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearVoiceCache();
  };
}
