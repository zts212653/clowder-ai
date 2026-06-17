import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const HELPER_PATH = resolve(process.cwd(), 'scripts/brand-dictionary-helper.mjs');

// ── Unit tests for the dictionary helper module ──

describe('brand-dictionary-helper', () => {
  // ── Path classification (F238 Phase C core) ──

  describe('classifyPath — F238 six-directory flips', () => {
    it('classifies assets/system-prompts/** as manual-port', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('assets/system-prompts/system-prompt-l0.md');
      assert.equal(result.classification, 'manual-port');
    });

    it('classifies assets/prompt-templates/** as manual-port', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('assets/prompt-templates/l1-identity.md');
      assert.equal(result.classification, 'manual-port');
    });

    it('classifies sop-definitions/** as manual-port', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('sop-definitions/development.yaml');
      assert.equal(result.classification, 'manual-port');
    });

    it('classifies desktop/** as manual-port', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('desktop/installer/setup.iss');
      assert.equal(result.classification, 'manual-port');
    });

    it('classifies guides/** as manual-port', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('guides/onboarding/welcome.yaml');
      assert.equal(result.classification, 'manual-port');
    });

    it('classifies cat-cafe-skills/** as manual-port', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('cat-cafe-skills/opensource-ops/SKILL.md');
      assert.equal(result.classification, 'manual-port');
    });
  });

  describe('classifyPath — brand-sensitive paths', () => {
    it('classifies packages/web/public/manifest.json as brand-sensitive', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('packages/web/public/manifest.json');
      assert.equal(result.classification, 'brand-sensitive');
    });

    it('classifies pet.json under concierge as brand-sensitive', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('packages/web/public/concierge/skins/ragdoll-v1/pet.json');
      assert.equal(result.classification, 'brand-sensitive');
    });
  });

  describe('classifyPath — safe-cherry-pick (default)', () => {
    it('classifies packages/api/src/index.ts as safe-cherry-pick', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('packages/api/src/index.ts');
      assert.equal(result.classification, 'safe-cherry-pick');
    });

    it('classifies packages/web/src/components/Foo.tsx as safe-cherry-pick', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('packages/web/src/components/Foo.tsx');
      assert.equal(result.classification, 'safe-cherry-pick');
    });
  });

  describe('classifyPath — risk levels from dictionary', () => {
    it('returns P0 risk for system-prompts', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('assets/system-prompts/system-prompt-l0.md');
      assert.equal(result.risk, 'P0');
    });

    it('returns P1 risk for manifest.json', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('packages/web/public/manifest.json');
      assert.equal(result.risk, 'P1');
    });

    it('returns null risk for safe-cherry-pick paths', async () => {
      const { classifyPath } = await import(HELPER_PATH);
      const result = classifyPath('packages/api/src/index.ts');
      assert.equal(result.risk, null);
    });
  });

  // ── Home term extraction ──

  describe('getHomeTerms', () => {
    it('returns terms with id, severity, and home patterns', async () => {
      const { getHomeTerms } = await import(HELPER_PATH);
      const terms = getHomeTerms();
      assert.ok(Array.isArray(terms));
      assert.ok(terms.length > 0);
      // Check structure
      const first = terms[0];
      assert.ok(first.id);
      assert.ok(first.severity);
      assert.ok(Array.isArray(first.homePatterns));
      assert.ok(first.homePatterns.length > 0);
    });

    it('includes product.primary with Clowder AI variants', async () => {
      const { getHomeTerms } = await import(HELPER_PATH);
      const terms = getHomeTerms();
      const primary = terms.find((t) => t.id === 'product.primary');
      assert.ok(primary, 'product.primary term should exist');
      assert.ok(primary.homePatterns.includes('Clowder AI'));
      assert.ok(primary.homePatterns.includes('Clowder AI'));
    });

    it('includes l4.redis_sanctum with production data boundary', async () => {
      const { getHomeTerms } = await import(HELPER_PATH);
      const terms = getHomeTerms();
      const sanctum = terms.find((t) => t.id === 'l4.redis_sanctum');
      assert.ok(sanctum, 'l4.redis_sanctum term should exist');
      assert.ok(sanctum.homePatterns.includes('production data boundary'));
    });
  });

  // ── Brand-sensitive pattern list (for pre-commit hook) ──

  describe('getBrandSensitivePatterns', () => {
    it('returns complete set of brand-sensitive glob patterns', async () => {
      const { getBrandSensitivePatterns } = await import(HELPER_PATH);
      const patterns = getBrandSensitivePatterns();
      assert.ok(Array.isArray(patterns));
      // All 3 brand-sensitive entries in the dictionary must be present.
      // This is the completeness gate — runtime cross-validation only spot-checks;
      // this test catches silent entry drops that would let paths escape the guard.
      assert.ok(patterns.includes('packages/web/public/manifest.json'), 'missing manifest.json');
      assert.ok(patterns.includes('packages/web/public/concierge/**/pet.json'), 'missing pet.json glob');
      assert.ok(patterns.includes('packages/web/public/icons/**'), 'missing icons/** glob');
      assert.ok(patterns.length >= 3, `expected >= 3 brand-sensitive patterns, got ${patterns.length}`);
    });
  });

  // ── CLI interface (for bash consumption) ──

  describe('CLI --classify-path', () => {
    it('outputs JSON classification for a manual-port path', () => {
      const output = execFileSync('node', [HELPER_PATH, '--classify-path', 'assets/system-prompts/foo.md'], {
        encoding: 'utf-8',
        cwd: process.cwd(),
      });
      const result = JSON.parse(output.trim());
      assert.equal(result.classification, 'manual-port');
      assert.equal(result.risk, 'P0');
    });

    it('outputs JSON classification for a safe-cherry-pick path', () => {
      const output = execFileSync('node', [HELPER_PATH, '--classify-path', 'packages/api/src/foo.ts'], {
        encoding: 'utf-8',
        cwd: process.cwd(),
      });
      const result = JSON.parse(output.trim());
      assert.equal(result.classification, 'safe-cherry-pick');
    });
  });

  describe('CLI --manual-port-patterns', () => {
    it('outputs one pattern per line including the 6 F238 directories', () => {
      const output = execFileSync('node', [HELPER_PATH, '--manual-port-patterns'], {
        encoding: 'utf-8',
        cwd: process.cwd(),
      });
      const lines = output.trim().split('\n');
      assert.ok(lines.length >= 6, `Expected >= 6 patterns, got ${lines.length}`);
      // All 6 F238 flips must be present
      assert.ok(lines.some((l) => l.includes('assets/system-prompts')));
      assert.ok(lines.some((l) => l.includes('assets/prompt-templates')));
      assert.ok(lines.some((l) => l.includes('sop-definitions')));
      assert.ok(lines.some((l) => l.includes('desktop')));
      assert.ok(lines.some((l) => l.includes('guides')));
      assert.ok(lines.some((l) => l.includes('cat-cafe-skills')));
    });
  });
});
