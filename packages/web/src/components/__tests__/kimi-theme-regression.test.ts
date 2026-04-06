import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, '..', '..', '..');
const globalsCssPath = resolve(webRoot, 'src', 'app', 'globals.css');
const tailwindConfigPath = resolve(webRoot, 'tailwind.config.js');

describe('kimi theme regression', () => {
  it('keeps Kimi CSS tokens aligned with the gray 梵花猫 palette', () => {
    const css = readFileSync(globalsCssPath, 'utf8');
    expect(css).toContain('--color-kimi-primary: #4b5563;');
    expect(css).toContain('--color-kimi-light: #e5e7eb;');
    expect(css).toContain('--color-kimi-dark: #1f2937;');
    expect(css).toContain('--color-kimi-bg: #f9fafb;');
    expect(css).not.toContain('--color-kimi-primary: #7c3aed;');
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
