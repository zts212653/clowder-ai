/**
 * An existing runtime catalog keeps the voice config it was seeded with; template fixes do not
 * reach it. The siamese Bennett clip was seeded with a transcript the clip does not say, so
 * catalog bootstrap repairs exactly that known pair and leaves any other text alone.
 *
 * The first two tests follow what a runtime restart does: the API startup entry
 * bootstrapDefaultCatCatalog() (src/index.ts) runs catalog bootstrap, then voices are read
 * through the normal path getCatVoice -> loadCatConfig (template merged with the catalog).
 */

import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { bootstrapCatCatalog, resolveCatCatalogPath, writeCatCatalog } = await import(
  '../dist/config/cat-catalog-store.js'
);
const { clearVoiceCache, getCatVoice } = await import('../dist/config/cat-voices.js');
const { bootstrapDefaultCatCatalog } = await import('../dist/config/cat-config-loader.js');

const REPO_TEMPLATE = new URL('../../../cat-template.json', import.meta.url);
const CLIP = 'genshin/班尼特/vo_bennett_dialog_greetingNight.wav';
const WRONG = '晚上好！今天的冒险怎么样？';
const RIGHT = '要不要陪我去和老爹们聊聊天啊？老冒险家的故事可有意思了！';

function findClipVoice(config) {
  for (const breed of config.breeds) {
    for (const variant of breed.variants ?? []) {
      if (variant.voiceConfig?.refAudio === CLIP) return variant.voiceConfig;
    }
  }
  return undefined;
}

function makeProjectWithCatalogText(catalogRefText) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'voice-ref-text-repair-'));
  const templatePath = join(projectRoot, 'cat-template.json');
  const template = JSON.parse(readFileSync(REPO_TEMPLATE, 'utf8'));
  writeFileSync(templatePath, JSON.stringify(template, null, 2));
  const catalog = structuredClone(template);
  const voice = findClipVoice(catalog);
  assert.ok(voice, 'template should contain the Bennett clip, otherwise this test checks nothing');
  voice.refText = catalogRefText;
  writeCatCatalog(projectRoot, catalog);
  return { projectRoot, templatePath, catalogPath: resolveCatCatalogPath(projectRoot) };
}

describe('runtime catalog repair of the known Bennett transcript mismatch', () => {
  const saved = {
    CAT_TEMPLATE_PATH: process.env.CAT_TEMPLATE_PATH,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT,
  };

  beforeEach(() => {
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = mkdtempSync(join(tmpdir(), 'voice-ref-text-global-'));
    clearVoiceCache();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearVoiceCache();
  });

  it('an existing catalog with the wrong transcript is repaired and the normal read path returns the right one', () => {
    const { templatePath, catalogPath } = makeProjectWithCatalogText(WRONG);
    process.env.CAT_TEMPLATE_PATH = templatePath;
    clearVoiceCache();
    assert.equal(getCatVoice('gemini').refText, WRONG, 'before restart the stale catalog is what gets read');

    bootstrapDefaultCatCatalog();
    clearVoiceCache();
    assert.equal(getCatVoice('gemini').refText, RIGHT);
    assert.equal(findClipVoice(JSON.parse(readFileSync(catalogPath, 'utf8'))).refText, RIGHT);
  });

  it('leaves a user-customized transcript for the same clip untouched', () => {
    const custom = '这是我自己重新录的一句话';
    const { templatePath, catalogPath } = makeProjectWithCatalogText(custom);
    process.env.CAT_TEMPLATE_PATH = templatePath;
    bootstrapDefaultCatCatalog();
    clearVoiceCache();

    assert.equal(getCatVoice('gemini').refText, custom);
    assert.equal(findClipVoice(JSON.parse(readFileSync(catalogPath, 'utf8'))).refText, custom);
  });

  it('is idempotent: a second bootstrap leaves the repaired catalog byte-identical', () => {
    const { projectRoot, templatePath, catalogPath } = makeProjectWithCatalogText(WRONG);
    bootstrapCatCatalog(projectRoot, templatePath);
    const first = readFileSync(catalogPath, 'utf8');
    bootstrapCatCatalog(projectRoot, templatePath);
    assert.equal(readFileSync(catalogPath, 'utf8'), first);
    assert.equal(findClipVoice(JSON.parse(first)).refText, RIGHT);
  });
});
