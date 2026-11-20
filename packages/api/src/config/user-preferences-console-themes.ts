import { readUserPreferencesStrict, updateUserPreferences } from './user-preferences-store.js';

/** The console's custom themes of one owner (theme documents and the active one), or null before the first save. */
export function readConsoleThemes(projectRoot: string, ownerUserId: string): unknown {
  return readUserPreferencesStrict(projectRoot).consoleThemes?.[ownerUserId] ?? null;
}

export function saveConsoleThemes(projectRoot: string, ownerUserId: string, themes: Record<string, unknown>): void {
  updateUserPreferences(
    projectRoot,
    (current) => ({ ...current, consoleThemes: { ...current.consoleThemes, [ownerUserId]: themes } }),
    { strictRead: true },
  );
}
