/**
 * T1: F231 Phase E — shared profile corpus contract constants + revision function.
 *
 * INV-4: profileRevisionOf produces deterministic sha256 revision strings.
 * Gate §4 terminal schema: CURRENT_CORPUS_PROFILE_URI, PROFILE_CORPUS_RELATIVE_PATH,
 * profileCorpusRelativePath(), profileRevisionOf().
 */
import { describe, expect, it } from 'vitest';
import {
  CURRENT_CORPUS_PROFILE_URI,
  PROFILE_CORPUS_RELATIVE_PATH,
  profileCorpusRelativePath,
} from '../profile-contract.js';
import { profileRevisionOf } from '../profile-revision.js';
import { PROFILE_UPDATE_TARGET_LAYERS, type ProfileUpdateTargetLayer } from '../types/profile-update.js';

describe('F231 Phase E: profile corpus contract', () => {
  describe('CURRENT_CORPUS_PROFILE_URI', () => {
    it('is the canonical corpus URI', () => {
      expect(CURRENT_CORPUS_PROFILE_URI).toBe('cat-cafe-profile://corpus/current');
    });
  });

  describe('PROFILE_CORPUS_RELATIVE_PATH', () => {
    it('is the fixed corpus file relative path', () => {
      expect(PROFILE_CORPUS_RELATIVE_PATH).toBe('corpus/shared-facts.md');
    });
  });

  describe('profileCorpusRelativePath()', () => {
    it('returns PROFILE_CORPUS_RELATIVE_PATH', () => {
      expect(profileCorpusRelativePath()).toBe(PROFILE_CORPUS_RELATIVE_PATH);
    });
  });

  describe('profileRevisionOf()', () => {
    it('returns sha256-prefixed hex for non-empty content', () => {
      const revision = profileRevisionOf('hello world');
      expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('returns sha256-prefixed hex for empty content', () => {
      const revision = profileRevisionOf('');
      expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('is deterministic — same input gives same output', () => {
      expect(profileRevisionOf('test content')).toBe(profileRevisionOf('test content'));
    });

    it('differs for different content', () => {
      expect(profileRevisionOf('a')).not.toBe(profileRevisionOf('b'));
    });
  });

  describe('PROFILE_UPDATE_TARGET_LAYERS', () => {
    it('includes both primer and corpus', () => {
      expect(PROFILE_UPDATE_TARGET_LAYERS).toContain('primer');
      expect(PROFILE_UPDATE_TARGET_LAYERS).toContain('corpus');
      expect(PROFILE_UPDATE_TARGET_LAYERS).toHaveLength(2);
    });

    it('does NOT include capsule (gate §4: no capsule layer)', () => {
      expect(PROFILE_UPDATE_TARGET_LAYERS).not.toContain('capsule');
    });

    it('type-level: ProfileUpdateTargetLayer accepts primer and corpus', () => {
      const primer: ProfileUpdateTargetLayer = 'primer';
      const corpus: ProfileUpdateTargetLayer = 'corpus';
      expect(primer).toBe('primer');
      expect(corpus).toBe('corpus');
    });
  });
});
