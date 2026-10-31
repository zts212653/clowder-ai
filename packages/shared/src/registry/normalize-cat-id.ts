/**
 * normalizeCatId — resolve user input (cat name / alias / catId) to registered catId.
 *
 * F154 AC-A3: uses catRegistry as source of truth (not hardcoded aliases).
 * F154 AC-A7 / KD-8: ambiguous partial match → reject with candidate list.
 *
 * Priority: exact catId → exact alias (strip @, case-insensitive) → partial displayName/nickname.
 */

import type { CatId } from '../types/ids.js';
import { createCatId } from '../types/ids.js';
import { catRegistry } from './CatRegistry.js';

export type NormalizeCatResult =
  | { ok: true; catId: CatId }
  | { ok: false; reason: 'not-found'; input: string }
  | { ok: false; reason: 'ambiguous'; input: string; candidates: string[] };

function catMentionPatterns(config: { mentionPatterns?: unknown }): readonly string[] {
  if (!Array.isArray(config.mentionPatterns)) {
    return [];
  }
  return config.mentionPatterns.filter((pattern): pattern is string => typeof pattern === 'string');
}

function catSearchLabels(config: { displayName?: unknown; nickname?: unknown }): string[] {
  const labels: string[] = [];
  if (typeof config.displayName === 'string') {
    labels.push(config.displayName);
  }
  if (typeof config.nickname === 'string') {
    labels.push(config.nickname);
  }
  return labels;
}

function findExactAlias(allConfigs: Record<string, { mentionPatterns?: unknown }>, lower: string): CatId | undefined {
  for (const [catId, config] of Object.entries(allConfigs)) {
    for (const pattern of catMentionPatterns(config)) {
      const stripped = pattern.startsWith('@') ? pattern.slice(1) : pattern;
      if (stripped.toLowerCase() === lower) {
        return createCatId(catId);
      }
    }
  }
  return undefined;
}

function findPartialMatches(
  allConfigs: Record<string, { displayName?: unknown; nickname?: unknown }>,
  lower: string,
): string[] {
  const partials: string[] = [];
  for (const [catId, config] of Object.entries(allConfigs)) {
    if (catSearchLabels(config).some((label) => label.toLowerCase().includes(lower))) {
      partials.push(catId);
    }
  }
  return partials;
}

export function normalizeCatId(input: string): NormalizeCatResult {
  const cleaned = input.startsWith('@') ? input.slice(1) : input;
  const lower = cleaned.toLowerCase();

  if (!lower) {
    return { ok: false, reason: 'not-found', input: cleaned };
  }

  // 1. Exact catId match (case-insensitive)
  if (catRegistry.has(lower)) {
    return { ok: true, catId: createCatId(lower) };
  }

  // 2. Exact alias match (mentionPatterns without @, case-insensitive)
  const allConfigs = catRegistry.getAllConfigs();
  const exactAlias = findExactAlias(allConfigs, lower);
  if (exactAlias) {
    return { ok: true, catId: exactAlias };
  }

  // 3. Partial displayName / nickname match
  const partials = findPartialMatches(allConfigs, lower);

  if (partials.length === 1) {
    return { ok: true, catId: createCatId(partials[0]) };
  }
  if (partials.length > 1) {
    return { ok: false, reason: 'ambiguous', input: cleaned, candidates: partials };
  }

  return { ok: false, reason: 'not-found', input: cleaned };
}
