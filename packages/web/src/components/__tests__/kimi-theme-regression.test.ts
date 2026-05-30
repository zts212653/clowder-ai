// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, '..', '..', '..');
const catHueInjectorPath = resolve(webRoot, 'src', 'components', 'CatHueInjector.tsx');
const tailwindConfigPath = resolve(webRoot, 'tailwind.config.js');

describe('kimi theme regression', () => {
  it('CatHueInjector generates tokens dynamically for ALL cats (no hardcoded slug map)', () => {
    const src = readFileSync(catHueInjectorPath, 'utf8');
    // Post-Option B: no hardcoded CAT_ID_TO_SLUG mapping — all cats get tokens via cat.id
    expect(src).not.toMatch(/CAT_ID_TO_SLUG/);
    // Dynamic injection uses cat.id directly as CSS key
    expect(src).toContain('cat.id');
    expect(src).toContain('hexToOklch');
    // No legacy compat layer needed — runtime catId is already the short name
    expect(src).not.toMatch(/legacyAlias/);
    // No hardcoded old purple hex
    expect(src).not.toContain('#7c3aed');
  });

  it('exports a kimi color family in tailwind so sidebar/session-chain classes compile', async () => {
    const configModule = await import(tailwindConfigPath);
    const config = configModule.default ?? configModule;
    expect(config.theme.extend.colors.kimi).toEqual({
      primary: 'var(--color-kimi-primary)',
      light: 'var(--color-kimi-light)',
      dark: 'var(--color-kimi-dark)',
      bg: 'var(--color-kimi-bg)',
    });
  });
});
