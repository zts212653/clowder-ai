/**
 * F166: Cat display order persistence.
 * Stores user's custom cat ordering in .cat-cafe/user-preferences.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { UserPreferences } from '@cat-cafe/shared';

function preferencesPath(projectRoot: string): string {
  return resolve(projectRoot, '.cat-cafe', 'user-preferences.json');
}

function readPreferences(projectRoot: string): UserPreferences {
  const path = preferencesPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as UserPreferences) : {};
  } catch {
    return {};
  }
}

function writePreferences(projectRoot: string, prefs: UserPreferences): void {
  mkdirSync(resolve(projectRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(preferencesPath(projectRoot), `${JSON.stringify(prefs, null, 2)}\n`, 'utf-8');
}

export function loadCatOrder(projectRoot: string): string[] {
  const prefs = readPreferences(projectRoot);
  if (!Array.isArray(prefs.catOrder)) return [];
  return prefs.catOrder.filter((id): id is string => typeof id === 'string');
}

export function saveCatOrder(projectRoot: string, catIds: string[]): void {
  const prefs = readPreferences(projectRoot);
  writePreferences(projectRoot, { ...prefs, catOrder: catIds });
}
