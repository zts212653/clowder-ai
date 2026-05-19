/**
 * F103: Per-cat voice identity regression tests
 * Env var backward compat (GENSHIN_VOICE_DIR) + path.isAbsolute safety
 */

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearVoiceCache, getCatVoice } from '../dist/config/cat-voices.js';

// F103: GENSHIN_VOICE_DIR backward compatibility
describe('GENSHIN_VOICE_DIR backward compat (P1)', () => {
  beforeEach(() => {
    clearVoiceCache();
    delete process.env.CHARACTER_VOICE_DIR;
    delete process.env.GENSHIN_VOICE_DIR;
    delete process.env.CAT_OPUS_TTS_VOICE;
    delete process.env.CAT_CODEX_TTS_VOICE;
    delete process.env.CAT_GEMINI_TTS_VOICE;
  });

  afterEach(() => {
    delete process.env.CHARACTER_VOICE_DIR;
    delete process.env.GENSHIN_VOICE_DIR;
    clearVoiceCache();
  });

  it('CHARACTER_VOICE_DIR takes precedence when set', () => {
    process.env.CHARACTER_VOICE_DIR = '/custom/character-models';
    clearVoiceCache();
    const voice = getCatVoice('opus');
    if (voice.refAudio) {
      assert.ok(
        voice.refAudio.startsWith('/custom/character-models'),
        `refAudio should use CHARACTER_VOICE_DIR, got: ${voice.refAudio}`,
      );
    }
  });

  it('CHARACTER_VOICE_DIR still wins when runtime config loading falls back', () => {
    const savedTemplatePath = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = '/tmp/nonexistent-cat-template-for-voice-test.json';
    process.env.CHARACTER_VOICE_DIR = '/custom/character-models';
    clearVoiceCache();
    try {
      const voice = getCatVoice('opus');
      if (voice.refAudio) {
        assert.ok(
          voice.refAudio.startsWith('/custom/character-models'),
          `fallback refAudio should use CHARACTER_VOICE_DIR, got: ${voice.refAudio}`,
        );
      }
    } finally {
      if (savedTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = savedTemplatePath;
      clearVoiceCache();
    }
  });

  it('GENSHIN_VOICE_DIR remains the exact fallback genshin directory when runtime config loading falls back', () => {
    const savedTemplatePath = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = '/tmp/nonexistent-cat-template-for-voice-test.json';
    process.env.GENSHIN_VOICE_DIR = '/custom/not-literally-genshin';
    clearVoiceCache();
    try {
      const voice = getCatVoice('ragdoll');
      assert.ok(voice.refAudio, 'fallback breed default should include refAudio');
      assert.ok(
        voice.refAudio.startsWith('/custom/not-literally-genshin/'),
        `fallback refAudio should use exact GENSHIN_VOICE_DIR, got: ${voice.refAudio}`,
      );
    } finally {
      if (savedTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = savedTemplatePath;
      clearVoiceCache();
    }
  });

  it('GENSHIN_VOICE_DIR infers character base when CHARACTER_VOICE_DIR unset', () => {
    process.env.GENSHIN_VOICE_DIR = '/my/custom/path/genshin';
    clearVoiceCache();
    const voice = getCatVoice('opus');
    if (voice.refAudio) {
      assert.ok(
        voice.refAudio.startsWith('/my/custom/path/'),
        `refAudio should derive base from GENSHIN_VOICE_DIR parent, got: ${voice.refAudio}`,
      );
    }
  });

  it('honkai-starrail paths also resolve via GENSHIN_VOICE_DIR parent', () => {
    process.env.GENSHIN_VOICE_DIR = '/my/custom/path/genshin';
    clearVoiceCache();
    const voice = getCatVoice('sonnet');
    if (voice.refAudio && voice.refAudio.includes('honkai-starrail')) {
      assert.ok(
        voice.refAudio.startsWith('/my/custom/path/honkai-starrail'),
        `honkai-starrail path should resolve from GENSHIN_VOICE_DIR parent, got: ${voice.refAudio}`,
      );
    }
  });
});

// F103: path.isAbsolute() cross-platform safety (P2)
describe('refAudio absolute path detection (P2)', () => {
  beforeEach(() => {
    clearVoiceCache();
    delete process.env.CHARACTER_VOICE_DIR;
    delete process.env.GENSHIN_VOICE_DIR;
  });

  afterEach(() => {
    delete process.env.CHARACTER_VOICE_DIR;
    delete process.env.GENSHIN_VOICE_DIR;
    clearVoiceCache();
  });

  it('absolute refAudio path is not re-joined with base dir', () => {
    const voice = getCatVoice('opus');
    if (voice.refAudio) {
      assert.ok(voice.refAudio.startsWith('/'), `refAudio should be absolute, got: ${voice.refAudio}`);
      const occurrences = voice.refAudio.split('character-models').length - 1;
      assert.ok(occurrences <= 1, `refAudio should not have double base dir: ${voice.refAudio}`);
    }
  });
});
