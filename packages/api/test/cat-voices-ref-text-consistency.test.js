/**
 * The same reference clip must carry the same transcript everywhere it is configured.
 *
 * 2026-10-05: the Bennett clip used for the siamese voice was paired with a line it does not say
 * in cat-template.json, cat-config.json and the built-in defaults at once. Voice cloning then
 * spoke the wrong line first and produced gibberish after it. The real transcript lives in the
 * clip's .lab file outside this repository, so this test cannot check it; it guards the other
 * half of the failure: fixing one copy and leaving the others wrong.
 */

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { clearVoiceCache, getCatVoice } from '../dist/config/cat-voices.js';

const REPO_ROOT = new URL('../../../', import.meta.url);
const VOICE_BASE = '/voices-for-test/genshin';
const DEFAULT_BREEDS = ['ragdoll', 'maine-coon', 'siamese'];

function addEntry(clips, clip, text, source) {
  if (!clips.has(clip)) clips.set(clip, []);
  clips.get(clip).push({ text, source });
}

function collectFromJson(node, clips, source) {
  if (Array.isArray(node)) {
    for (const item of node) collectFromJson(item, clips, source);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof node.refAudio === 'string' && typeof node.refText === 'string') {
    addEntry(clips, node.refAudio, node.refText, source);
  }
  for (const value of Object.values(node)) collectFromJson(value, clips, source);
}

describe('voice reference transcript consistency', () => {
  const saved = {
    CAT_TEMPLATE_PATH: process.env.CAT_TEMPLATE_PATH,
    GENSHIN_VOICE_DIR: process.env.GENSHIN_VOICE_DIR,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearVoiceCache();
  });

  it('every reference clip has one transcript across the template, available runtime config and built-in defaults', () => {
    const clips = new Map();
    for (const file of ['cat-template.json', 'cat-config.json']) {
      const path = new URL(file, REPO_ROOT);
      // The install-local catalog is optional and deliberately absent from public exports.
      // Always compare the shipped template and defaults; also check a catalog when present.
      if (file === 'cat-config.json' && !existsSync(path)) continue;
      collectFromJson(JSON.parse(readFileSync(path, 'utf8')), clips, file);
    }

    process.env.CAT_TEMPLATE_PATH = '/tmp/nonexistent-cat-template-for-ref-text-test.json';
    process.env.GENSHIN_VOICE_DIR = VOICE_BASE;
    clearVoiceCache();
    for (const breed of DEFAULT_BREEDS) {
      const voice = getCatVoice(breed);
      assert.ok(voice.refAudio && voice.refText, `built-in default for ${breed} should have refAudio and refText`);
      assert.ok(
        voice.refAudio.startsWith(`${VOICE_BASE}/`),
        `unexpected default refAudio for ${breed}: ${voice.refAudio}`,
      );
      const clip = `genshin/${voice.refAudio.slice(VOICE_BASE.length + 1)}`;
      addEntry(clips, clip, voice.refText, `cat-voices.ts default (${breed})`);
      assert.ok(
        clips.get(clip).some((entry) => entry.source === 'cat-template.json'),
        `default clip ${clip} should also appear in cat-template.json, otherwise this check compares nothing`,
      );
    }

    for (const [clip, entries] of clips) {
      const transcripts = new Set(entries.map((entry) => entry.text));
      assert.equal(
        transcripts.size,
        1,
        `${clip} is paired with different transcripts:\n${entries.map((e) => `  ${e.source}: ${e.text}`).join('\n')}`,
      );
    }
  });
});
