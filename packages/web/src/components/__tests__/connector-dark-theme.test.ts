import { getAllConnectorDefinitions } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';

import tailwindConfig from '../../../tailwind.config';

describe('connector dark mode themes', () => {
  it('Tailwind darkMode selector matches ThemeProvider data-theme attribute', () => {
    // ThemeProvider uses attribute="data-theme" (next-themes)
    // Tailwind must use matching selector so dark: classes follow in-app theme, not OS preference
    expect(tailwindConfig.darkMode).toEqual(['selector', '[data-theme="dark"]']);
  });

  it('all connectors with tailwindTheme use semantic conn-* tokens (not hardcoded colors)', () => {
    const defs = getAllConnectorDefinitions();
    for (const def of defs) {
      if (!def.tailwindTheme) continue;
      const theme = def.tailwindTheme;
      const allSlots = [theme.avatar, theme.label, theme.labelLink, theme.bubble];

      // Every slot should reference conn- semantic tokens, not raw Tailwind colors
      for (const slot of allSlots) {
        expect(slot, `${def.id} tailwindTheme should use conn-* tokens`).toContain('conn-');
      }

      // No raw Tailwind bg/text/border colors (e.g., bg-blue-100, text-slate-700)
      for (const slot of allSlots) {
        expect(slot, `${def.id} should not have hardcoded dark: variants`).not.toMatch(/\bdark:/);
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
