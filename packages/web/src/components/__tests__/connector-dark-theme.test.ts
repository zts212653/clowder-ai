import { getAllConnectorDefinitions } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';

import tailwindConfig from '../../../tailwind.config';

describe('connector dark mode themes', () => {
  it('Tailwind darkMode selector matches ThemeProvider data-theme attribute', () => {
    // ThemeProvider uses attribute="data-theme" (next-themes)
    // Tailwind must use matching selector so dark: classes follow in-app theme, not OS preference
    expect(tailwindConfig.darkMode).toEqual(['selector', '[data-theme="dark"]']);
  });

  it('all connectors have a valid themeColor hex', () => {
    const defs = getAllConnectorDefinitions();
    for (const def of defs) {
      expect(def.themeColor, `${def.id} must have a themeColor`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('all connectors have a structured icon spec', () => {
    const defs = getAllConnectorDefinitions();
    for (const def of defs) {
      expect(def.icon, `${def.id} must have an icon spec`).toBeDefined();
      if (def.icon.type === 'svg') {
        expect(typeof def.icon.iconId, `${def.id} svg icon must have iconId`).toBe('string');
      } else {
        expect(def.icon.src, `${def.id} png icon must have src`).toMatch(/^\//);
      }
    }
  });

  it('conn-* token utilities are registered in Tailwind config for all color groups', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tailwind config type doesn't include custom color groups
    const connColors = (tailwindConfig.theme?.extend?.colors as any)?.conn as Record<string, string> | undefined;
    expect(connColors).toBeDefined();

    const colorGroups = [
      'slate',
      'gray',
      'amber',
      'purple',
      'emerald',
      'blue',
      'sky',
      'cyan',
      'red',
      'indigo',
      'violet',
      'green',
    ];
    const suffixes = ['bg', 'ring', 'text', 'hover', 'bubble-bg', 'bubble-border'];

    for (const group of colorGroups) {
      for (const suffix of suffixes) {
        const key = `${group}-${suffix}`;
        expect(connColors?.[key], `conn.${key} should be registered`).toBeDefined();
        expect(connColors?.[key], `conn.${key} should reference CSS variable`).toMatch(/^var\(--/);
      }
    }
  });
});
