import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  resolveDocumentListenStatePath,
  resolveTtsCacheDir,
} from '../dist/domains/cats/services/tts/document-listen-paths.js';

describe('resolveDocumentListenStatePath', () => {
  const homeDir = path.join(path.sep, 'tmp', 'cat-cafe-home');

  it('stores durable state below the current user data root by default', () => {
    assert.equal(resolveDocumentListenStatePath({}, homeDir), path.join(homeDir, '.cat-cafe', 'listen-mode.sqlite'));
  });

  it('honors CAT_CAFE_DATA_DIR without depending on the paused F289 catalog', () => {
    const dataRoot = path.join(path.sep, 'var', 'cat-cafe-data');
    assert.equal(
      resolveDocumentListenStatePath({ CAT_CAFE_DATA_DIR: dataRoot }, homeDir),
      path.join(dataRoot, 'listen-mode.sqlite'),
    );
  });

  it('expands a home-relative CAT_CAFE_DATA_DIR before resolving durable state', () => {
    assert.equal(
      resolveDocumentListenStatePath({ CAT_CAFE_DATA_DIR: '~/.cat-cafe-custom' }, homeDir),
      path.join(homeDir, '.cat-cafe-custom', 'listen-mode.sqlite'),
    );
  });

  it('lets LISTEN_MODE_DB override both canonical root choices', () => {
    const override = path.join(path.sep, 'var', 'listen', 'custom.sqlite');
    assert.equal(
      resolveDocumentListenStatePath(
        { CAT_CAFE_DATA_DIR: path.join(path.sep, 'ignored'), LISTEN_MODE_DB: override },
        homeDir,
      ),
      override,
    );
  });

  it('expands a home-relative LISTEN_MODE_DB override', () => {
    assert.equal(
      resolveDocumentListenStatePath({ LISTEN_MODE_DB: '~/state/listen.sqlite' }, homeDir),
      path.join(homeDir, 'state', 'listen.sqlite'),
    );
  });
});

describe('resolveTtsCacheDir', () => {
  const homeDir = path.join(path.sep, 'tmp', 'cat-cafe-home');

  it('stores reusable audio below the stable user data root by default', () => {
    assert.equal(resolveTtsCacheDir({}, homeDir), path.join(homeDir, '.cat-cafe', 'assets', 'tts'));
  });

  it('keeps the default cache stable when CAT_CAFE_DATA_DIR uses a home-relative path', () => {
    assert.equal(
      resolveTtsCacheDir({ CAT_CAFE_DATA_DIR: '~/.cat-cafe-custom' }, homeDir),
      path.join(homeDir, '.cat-cafe-custom', 'assets', 'tts'),
    );
  });

  it('lets TTS_CACHE_DIR explicitly override the canonical cache root', () => {
    const override = path.join(path.sep, 'var', 'cache', 'cat-cafe-tts');
    assert.equal(
      resolveTtsCacheDir({ CAT_CAFE_DATA_DIR: path.join(path.sep, 'ignored'), TTS_CACHE_DIR: override }, homeDir),
      override,
    );
  });

  it('expands a home-relative TTS_CACHE_DIR override', () => {
    assert.equal(
      resolveTtsCacheDir({ TTS_CACHE_DIR: '~/custom-tts-cache' }, homeDir),
      path.join(homeDir, 'custom-tts-cache'),
    );
  });
});
