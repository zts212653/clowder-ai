import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatHueInjector } from '../CatHueInjector';

const catalogue = vi.hoisted(() => ({
  cats: [
    { id: 'kimi', color: { primary: '#ff0000' } },
    { id: 'new-member', color: { primary: '#00ff00' } },
  ],
}));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => catalogue }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dynamic cat theme', () => {
  it('injects configured colours for both Kimi and a newly registered cat', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    const style = document.documentElement.getAttribute('style');
    try {
      act(() => root.render(React.createElement(CatHueInjector)));
      expect(document.documentElement.style.getPropertyValue('--kimi-hue')).toBe('29.2');
      expect(document.documentElement.style.getPropertyValue('--kimi-chroma')).toBe('0.258');
      expect(document.documentElement.style.getPropertyValue('--new-member-hue')).toBe('142.5');
      const rules = document.getElementById('f056-dynamic-cat-tokens')?.textContent;
      expect(rules).toContain('--color-kimi-primary:var(--color-kimi-bubble)');
      expect(rules).toContain('--color-new-member-primary:var(--color-new-member-bubble)');
    } finally {
      act(() => root.unmount());
      document.getElementById('f056-dynamic-cat-tokens')?.remove();
      if (style === null) document.documentElement.removeAttribute('style');
      else document.documentElement.setAttribute('style', style);
    }
  });

  it('exports a kimi color family in tailwind so sidebar/session-chain classes compile', async () => {
    const configModule = await import('../../../tailwind.config.js');
    const config = configModule.default ?? configModule;
    expect(config.theme.extend.colors.kimi).toEqual({
      primary: 'var(--color-kimi-primary)',
      light: 'var(--color-kimi-light)',
      dark: 'var(--color-kimi-dark)',
      bg: 'var(--color-kimi-bg)',
    });
  });
});
