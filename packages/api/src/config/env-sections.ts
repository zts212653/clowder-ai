/**
 * #770: canonical section projection for module-level env configuration.
 *
 * The env registry (`env-registry.ts`) is the single canonical truth source for
 * *definitions*. This file is the single canonical truth source for *which
 * non-system variables appear in which module section* of the Hub UI.
 *
 * The `system` projection lives in `env-registry.ts` as `SYSTEM_VARS` and is
 * merged there into the final `SECTION_PROJECTION` export. This avoids a
 * circular import: `env-sections.ts` must not import `SYSTEM_VARS`.
 *
 * Design principles:
 * - Fail-closed: a variable that is not in `system` and not in any module
 *   section projection is hidden from the curated UI by default.
 * - Deprecated variables are excluded from every section summary.
 * - Module sections contain only non-system vars; system vars are not repeated.
 * - Masking and visibility policy live in the canonical `buildEnvSummary()` in
 *   `env-registry.ts`; this file only applies the section filter.
 */

import type { EnvDefinition } from './env-registry.js';

/** Hub UI sections that can host env configuration cards. */
export type EnvSectionKey = 'system' | 'im' | 'voice' | 'notify' | 'ops' | 'accounts' | 'members' | 'plugins';

/**
 * Module-level projection: for each section, the set of env var names that
 * should be surfaced in that section's settings UI.
 *
 * Notes on scope boundaries:
 * - `system` is intentionally omitted here; it is merged in `env-registry.ts`.
 * - PR-A intentionally leaves all module projections empty. A source audit
 *   (sol, HEAD f790c4ed2) showed the previously proposed 42-var projection
 *   mixed vars that already have dedicated module UI, internal/deploy-only
 *   knobs, and entries that need component-level extensions rather than a
 *   generic env card. The section/filter/write-policy infrastructure lands in
 *   PR-A; the actual per-module projected sets will be re-added in PR-C after
 *   each UI owner confirms a real dedicated surface is missing.
 * - Ownership metadata in the registry does **not** imply projection; only the
 *   sets below determine which non-system vars appear in the curated UI.
 */
export const MODULE_SECTION_PROJECTION: Readonly<Record<Exclude<EnvSectionKey, 'system'>, ReadonlySet<string>>> = {
  im: new Set(),
  voice: new Set(),
  notify: new Set(),
  ops: new Set(),
  accounts: new Set(),
  members: new Set(),
  plugins: new Set(),
};

/** All section keys, in a stable order suitable for UI navigation. */
export const ENV_SECTION_KEYS: readonly EnvSectionKey[] = [
  'system',
  'im',
  'voice',
  'notify',
  'ops',
  'accounts',
  'members',
  'plugins',
];

/** Human-readable labels for each section. */
export const ENV_SECTION_LABELS: Readonly<Record<EnvSectionKey, string>> = {
  system: '系统',
  im: '即时通讯',
  voice: '语音',
  notify: '通知',
  ops: '运维',
  accounts: '账户',
  members: '成员',
  plugins: '插件',
};

/** Return the module projection set for a section. */
export function getModuleSectionProjection(section: Exclude<EnvSectionKey, 'system'>): ReadonlySet<string> {
  return MODULE_SECTION_PROJECTION[section];
}

/**
 * Filter a canonical env summary down to the vars allowed in a section.
 * - Variables not in `allowed` are excluded.
 * - Deprecated variables are excluded.
 * - `hubVisible: false` vars are excluded (defensive: canonical summary should
 *   already have removed them, but the guard keeps the contract explicit).
 *
 * `canonicalSummary` must come from `buildEnvSummary()` in `env-registry.ts`
 * so that sensitive values are already masked and URL credentials are already
 * stripped.
 */
export function filterEnvSummaryForSection(
  allowed: ReadonlySet<string>,
  canonicalSummary: readonly (EnvDefinition & { currentValue: string | null })[],
): Array<EnvDefinition & { currentValue: string | null }> {
  return canonicalSummary.filter((def) => allowed.has(def.name) && !def.deprecated && def.hubVisible !== false);
}

/**
 * Build a filtered env summary for a module section.
 * - Variables not in the section projection are excluded.
 * - Deprecated variables are excluded.
 * - `hubVisible: false` vars are excluded.
 *
 * The second argument must be the canonical masked summary from
 * `buildEnvSummary()`; masking policy is intentionally not duplicated here.
 */
export function buildModuleSectionEnvSummary(
  section: Exclude<EnvSectionKey, 'system'>,
  canonicalSummary: readonly (EnvDefinition & { currentValue: string | null })[],
): Array<EnvDefinition & { currentValue: string | null }> {
  return filterEnvSummaryForSection(MODULE_SECTION_PROJECTION[section], canonicalSummary);
}
