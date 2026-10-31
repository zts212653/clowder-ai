/*
 * F056 ThemeApplier — bridges the theme store to next-themes + CSS injection
 *
 * Subscribes to the theme store and:
 * 1. Sets `data-theme` via next-themes when the active theme's base changes
 * 2. Injects CSS overrides from the active theme's params
 *
 * Must live inside <ThemeProvider> (next-themes context).
 */
'use client';

import { useEffect, useRef } from 'react';
import { useActualColours } from '@/hooks/useActualColours';
import { useCafeTheme } from '@/hooks/useCafeTheme';
import { applyThemeCSS, getActiveTheme, restoreFromServer, useThemeStore } from '@/stores/themeStore';

export function ThemeApplier() {
  const { theme, setTheme } = useCafeTheme();
  const active = useThemeStore((s) => getActiveTheme(s));
  const actual = useActualColours();
  const recoveryAttempted = useRef(false);

  /* On mount: if localStorage was empty, try recovering from server */
  useEffect(() => {
    if (recoveryAttempted.current) return;
    recoveryAttempted.current = true;
    let hasLocal = false;
    try {
      hasLocal = typeof window !== 'undefined' && !!localStorage.getItem('cat-cafe:themes');
    } catch {
      /* localStorage denied (sandboxed / private context) — treat as empty */
    }
    if (hasLocal) return;
    restoreFromServer().then((restored) => {
      if (restored) window.location.reload(); // reload to re-initialize store from recovered data
    });
  }, []);

  /* Sync base mode to next-themes (manages data-theme attribute on <html>) */
  useEffect(() => {
    if (theme === active.base) return;
    setTheme(active.base);
  }, [active.base, setTheme, theme]);

  /* Inject CSS overrides for the active theme's OKLCH params. The name role, the plate it sits on and the lineage ring are
   * resolved against the cats, connectors and human colour that really exist, so the theme is resolved again whenever the
   * catalogue or a colour changes (F322 B, Opus 5.5 3619). */
  useEffect(() => {
    applyThemeCSS(active.params, actual);
  }, [active.params, actual]);

  return null;
}
