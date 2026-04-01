/**
 * Tests for provider-aware CLI effort normalization (F000-cli-effort)
 *
 * Bug: cli.effort="max" (Claude's value) was passed directly to Codex CLI
 * as model_reasoning_effort="max", but Codex only accepts "xhigh", causing
 * immediate CLI startup failure.
 *
 * Fix: getCatEffort() now validates effort values against provider specs
 * and auto-maps invalid values to provider-correct defaults.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('getCatEffort - provider-aware effort normalization', () => {
  let previousConfig;
  let _resetCachedConfig;

  beforeEach(async () => {
    // Import fresh module and cache reset function
    const module = await import(`../../dist/config/cat-config-loader.js?t=${Date.now()}`);
    _resetCachedConfig = module._resetCachedConfig;
    // Reset config cache before each test
    _resetCachedConfig();
  });

  afterEach(() => {
    // Reset config cache after each test
    _resetCachedConfig?.();
  });

  describe('anthropic (Claude CLI)', () => {
    it('accepts valid effort values: low, medium, high, max', async () => {
      const { getCatEffort } = await import(`../../dist/config/cat-config-loader.js?t=${Date.now()}`);

      const testVariants = [
        { effort: 'low', expected: 'low' },
        { effort: 'medium', expected: 'medium' },
        { effort: 'high', expected: 'high' },
        { effort: 'max', expected: 'max' },
      ];

      for (const { effort, expected } of testVariants) {
        const mockConfig = {
          version: 2,
          breeds: [
            {
              id: 'test-breed',
              catId: 'test-cat',
              name: 'Test',
              displayName: 'Test Cat',
              avatar: 'test.png',
              color: { primary: '#fff', secondary: '#000' },
              mentionPatterns: ['@test'],
              roleDescription: 'Test',
              defaultVariantId: 'v1',
              variants: [
                {
                  id: 'v1',
                  provider: 'anthropic',
                  defaultModel: 'claude-3-5-sonnet-20241022',
                  mcpSupport: true,
                  cli: { command: 'claude', outputFormat: 'json', effort },
                },
              ],
            },
          ],
          roster: {},
          reviewPolicy: {
            requireDifferentFamily: true,
            preferActiveInThread: true,
            preferLead: true,
            excludeUnavailable: true,
          },
        };
        const result = getCatEffort('test-cat', mockConfig);
        assert.equal(result, expected, `anthropic: effort="${effort}" should return "${expected}"`);
      }
    });

    it('returns default "max" when effort not configured', async () => {
      const mockConfig = {
        version: 2,
        breeds: [
          {
            id: 'test-breed',
            catId: 'test-cat',
            name: 'Test',
            displayName: 'Test Cat',
            avatar: 'test.png',
            color: { primary: '#fff', secondary: '#000' },
            mentionPatterns: ['@test'],
            roleDescription: 'Test',
            defaultVariantId: 'v1',
            variants: [
              {
                id: 'v1',
                provider: 'anthropic',
                defaultModel: 'claude-3-5-sonnet-20241022',
                mcpSupport: true,
                cli: { command: 'claude', outputFormat: 'json' }, // no effort
              },
            ],
          },
        ],
        roster: {},
        reviewPolicy: {
          requireDifferentFamily: true,
          preferActiveInThread: true,
          preferLead: true,
          excludeUnavailable: true,
        },
      };

      const { getCatEffort } = await import(`../../dist/config/cat-config-loader.js?t=${Date.now()}`);
      const result = getCatEffort('test-cat', mockConfig);
      assert.equal(result, 'max', 'anthropic: default effort should be "max"');
    });
  });

  describe('openai (Codex CLI)', () => {
    it('accepts valid effort values: low, medium, high, xhigh', async () => {
      const mockConfig = {
        version: 2,
        breeds: [
          {
            id: 'test-breed',
            catId: 'codex-cat',
            name: 'Codex',
            displayName: 'Codex Cat',
            avatar: 'test.png',
            color: { primary: '#fff', secondary: '#000' },
            mentionPatterns: ['@codex'],
            roleDescription: 'Test',
            defaultVariantId: 'v1',
            variants: [
              {
                id: 'v1',
                provider: 'openai',
                defaultModel: 'o3-mini',
                mcpSupport: true,
                cli: { command: 'codex', outputFormat: 'json' },
              },
            ],
          },
        ],
        roster: {},
        reviewPolicy: {
          requireDifferentFamily: true,
          preferActiveInThread: true,
          preferLead: true,
          excludeUnavailable: true,
        },
      };

      const { getCatEffort } = await import(`../../dist/config/cat-config-loader.js?t=${Date.now()}`);

      const testVariants = [
        { effort: 'low', expected: 'low' },
        { effort: 'medium', expected: 'medium' },
        { effort: 'high', expected: 'high' },
        { effort: 'xhigh', expected: 'xhigh' },
      ];

      for (const { effort, expected } of testVariants) {
        mockConfig.breeds[0].variants[0].cli.effort = effort;
        const result = getCatEffort('codex-cat', mockConfig);
        assert.equal(result, expected, `openai: effort="${effort}" should return "${expected}"`);
      }
    });

    it('normalizes invalid "max" to "xhigh" (BUG FIX)', async () => {
      const mockConfig = {
        version: 2,
        breeds: [
          {
            id: 'test-breed',
            catId: 'codex-cat',
            name: 'Codex',
            displayName: 'Codex Cat',
            avatar: 'test.png',
            color: { primary: '#fff', secondary: '#000' },
            mentionPatterns: ['@codex'],
            roleDescription: 'Test',
            defaultVariantId: 'v1',
            variants: [
              {
                id: 'v1',
                provider: 'openai',
                defaultModel: 'o3-mini',
                mcpSupport: true,
                cli: { command: 'codex', outputFormat: 'json', effort: 'max' }, // INVALID for Codex!
              },
            ],
          },
        ],
        roster: {},
        reviewPolicy: {
          requireDifferentFamily: true,
          preferActiveInThread: true,
          preferLead: true,
          excludeUnavailable: true,
        },
      };

      const { getCatEffort } = await import(`../../dist/config/cat-config-loader.js?t=${Date.now()}`);
      const result = getCatEffort('codex-cat', mockConfig);
      assert.equal(result, 'xhigh', 'openai: invalid effort="max" should normalize to "xhigh"');
    });

    it('returns default "xhigh" when effort not configured', async () => {
      const mockConfig = {
        version: 2,
        breeds: [
          {
            id: 'test-breed',
            catId: 'codex-cat',
            name: 'Codex',
            displayName: 'Codex Cat',
            avatar: 'test.png',
            color: { primary: '#fff', secondary: '#000' },
            mentionPatterns: ['@codex'],
            roleDescription: 'Test',
            defaultVariantId: 'v1',
            variants: [
              {
                id: 'v1',
                provider: 'openai',
                defaultModel: 'o3-mini',
                mcpSupport: true,
                cli: { command: 'codex', outputFormat: 'json' }, // no effort
              },
            ],
          },
        ],
        roster: {},
        reviewPolicy: {
          requireDifferentFamily: true,
          preferActiveInThread: true,
          preferLead: true,
          excludeUnavailable: true,
        },
      };

      const { getCatEffort } = await import(`../../dist/config/cat-config-loader.js?t=${Date.now()}`);
      const result = getCatEffort('codex-cat', mockConfig);
      assert.equal(result, 'xhigh', 'openai: default effort should be "xhigh"');
    });
  });

  describe('google (Gemini CLI)', () => {
    it('accepts valid effort values: low, medium, high, max', async () => {
      const mockConfig = {
        version: 2,
        breeds: [
          {
            id: 'test-breed',
            catId: 'gemini-cat',
            name: 'Gemini',
            displayName: 'Gemini Cat',
            avatar: 'test.png',
            color: { primary: '#fff', secondary: '#000' },
            mentionPatterns: ['@gemini'],
            roleDescription: 'Test',
            defaultVariantId: 'v1',
            variants: [
              {
                id: 'v1',
                provider: 'google',
                defaultModel: 'gemini-2.5-flash',
                mcpSupport: false,
                cli: { command: 'gemini', outputFormat: 'json' },
              },
            ],
          },
        ],
        roster: {},
        reviewPolicy: {
          requireDifferentFamily: true,
          preferActiveInThread: true,
          preferLead: true,
          excludeUnavailable: true,
        },
      };

      const { getCatEffort } = await import(`../../dist/config/cat-config-loader.js?t=${Date.now()}`);

      const testVariants = [
        { effort: 'low', expected: 'low' },
        { effort: 'medium', expected: 'medium' },
        { effort: 'high', expected: 'high' },
        { effort: 'max', expected: 'max' },
      ];

      for (const { effort, expected } of testVariants) {
        mockConfig.breeds[0].variants[0].cli.effort = effort;
        const result = getCatEffort('gemini-cat', mockConfig);
        assert.equal(result, expected, `google: effort="${effort}" should return "${expected}"`);
      }
    });
  });

  describe('edge cases', () => {
    it('handles unknown cat with fallback', async () => {
      const { getCatEffort } = await import(`../../dist/config/cat-config-loader.js?t=${Date.now()}`);
      const result = getCatEffort('nonexistent-cat');
      assert.equal(result, 'max', 'unknown cat should fallback to "max"');
    });

    it('handles null config with fallback', async () => {
      const { getCatEffort } = await import(`../../dist/config/cat-config-loader.js?t=${Date.now()}`);
      const result = getCatEffort('any-cat', null);
      assert.equal(result, 'max', 'null config should fallback to "max"');
    });
  });
});
