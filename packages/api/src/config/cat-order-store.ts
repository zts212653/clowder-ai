/**
 * F166: Cat display order persistence.
 * Stores user's custom cat ordering in .cat-cafe/user-preferences.json.
 */

import { readUserPreferences, updateUserPreferences } from './user-preferences-store.js';

export function loadCatOrder(projectRoot: string): string[] {
  const prefs = readUserPreferences(projectRoot);
  if (!Array.isArray(prefs.catOrder)) return [];
  return prefs.catOrder.filter((id): id is string => typeof id === 'string');
}

export function saveCatOrder(projectRoot: string, catIds: string[]): void {
  updateUserPreferences(projectRoot, (prefs) => ({ ...prefs, catOrder: catIds }));
}
