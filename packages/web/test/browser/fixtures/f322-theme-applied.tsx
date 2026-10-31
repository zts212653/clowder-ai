import { useEffect } from 'react';
import { useActualColours } from '@/hooks/useActualColours';
import type { ActualColours } from '@/lib/readable-name-plate';
import { getActiveTheme, useThemeStore } from '@/stores/themeStore';

/**
 * Shared by the F322 B theme probes: tells a journey when the REAL `ThemeApplier` has put the active theme on the page,
 * resolved against the colours that really exist (the catalogue and the human's configured colour).
 *
 * Mount `<ActualProbe />` AFTER `<ThemeApplier />` in the tree: effects of siblings run in order, so by the time the probe
 * records what the same hook says the room is, the applier has already applied it. `themeApplied()` then resolves when what
 * `applyThemeCSS` left on the window (the very params object and the colours it resolved against) is the store's active theme
 * and the room the probe sees. It does not guess with timers; it rejects after `timeoutMs` and says what it saw.
 */
let latest: ActualColours | undefined;

export function ActualProbe() {
  const actual = useActualColours();
  useEffect(() => {
    latest = actual;
  }, [actual]);
  return null;
}

interface ThemeDebug {
  params: unknown;
  actual: ActualColours | null;
}

export function themeApplied(timeoutMs = 4000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      const active = getActiveTheme(useThemeStore.getState());
      const debug = (window as unknown as { __f056ThemeDebug?: ThemeDebug }).__f056ThemeDebug;
      const roomKnown = latest !== undefined && debug?.actual != null;
      const sameRoom = roomKnown && JSON.stringify(debug?.actual) === JSON.stringify(latest);
      const shown = debug?.params === active.params && sameRoom;
      if (shown && document.documentElement.getAttribute('data-theme') === active.base) return resolve();
      if (performance.now() - started > timeoutMs)
        return reject(
          new Error(
            `theme not applied: active=${active.id} base=${document.documentElement.getAttribute('data-theme')} sameParams=${debug?.params === active.params} sameRoom=${sameRoom}`,
          ),
        );
      requestAnimationFrame(check);
    };
    check();
  });
}
