/**
 * Mount Rules Store — F228
 *
 * Data source: capabilities.json#mountRules (v2) or #defaultMountRules.
 *
 * Adapter pattern: readMountRules() converts MountRuleEntry[] → MountRules (old format)
 * so downstream consumers (drift-detector, skill-sync-engine, drift-resolver,
 * mount-rules route, skill-mount) get zero changes.
 */

import { isAbsolute } from 'node:path';
import {
  type CapabilitiesConfig,
  type CustomMountPointRule,
  DEFAULT_MOUNT_RULES,
  type MountRuleEntry,
  type MountRules,
  STANDARD_MOUNT_POINT_IDS,
  type StandardMountPointId,
  type StandardMountPointRule,
} from '@cat-cafe/shared';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../capabilities/capability-orchestrator.js';

const STANDARD_MOUNT_POINT_SET = new Set<string>(STANDARD_MOUNT_POINT_IDS);

function hasWindowsAbsolutePrefix(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isSafeMountPointPath(value: string): boolean {
  if (value.trim() !== value || value.includes('\0')) return false;
  if (isAbsolute(value) || hasWindowsAbsolutePrefix(value)) return false;
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) return false;
  return segments.some((segment) => segment !== '' && segment !== '.');
}

function isSafeCustomMountPath(value: string): boolean {
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) return false;
  return isSafeMountPointPath(value);
}

function validateStandardMountPointRule(input: unknown): StandardMountPointRule | null {
  if (!input || typeof input !== 'object') return null;
  const entry = input as Record<string, unknown>;
  if (typeof entry.enabled !== 'boolean') return null;
  if (typeof entry.path !== 'string' || entry.path.length === 0 || !isSafeMountPointPath(entry.path)) return null;
  return { enabled: entry.enabled, path: entry.path };
}

/** Safe mount-point-id pattern: lowercase alphanum, hyphens, underscores. */
const SAFE_ALIAS_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function validateCustomMountPointRule(input: unknown): CustomMountPointRule | null {
  if (!input || typeof input !== 'object') return null;
  const entry = input as Record<string, unknown>;
  if (typeof entry.alias !== 'string' || entry.alias.length === 0) return null;
  // Reject aliases with path separators, dots, control chars, or other unsafe patterns.
  // alias is used in backup filenames (drift-resolver) and as map keys.
  if (!SAFE_ALIAS_RE.test(entry.alias)) return null;
  if (STANDARD_MOUNT_POINT_SET.has(entry.alias)) return null;
  if (typeof entry.path !== 'string' || entry.path.length === 0 || !isSafeCustomMountPath(entry.path)) return null;
  return { alias: entry.alias, path: entry.path };
}

// ─── Adapter: MountRuleEntry[] ↔ MountRules ─────────────────────

/**
 * Convert old MountRules shape → v2 MountRuleEntry[].
 * Inverse of mountRuleEntriesToMountRules().
 */
export function mountRulesToMountRuleEntries(rules: MountRules): MountRuleEntry[] {
  const entries: MountRuleEntry[] = [];
  for (const id of STANDARD_MOUNT_POINT_IDS) {
    const p = rules.mountPoints[id];
    if (p) entries.push({ name: id, path: p.path, enabled: p.enabled });
  }
  for (const cp of rules.customPaths ?? []) {
    entries.push({ name: cp.alias, path: cp.path, enabled: true });
  }
  return entries;
}

/**
 * Convert v2 MountRuleEntry[] to the old MountRules shape.
 * Standard mount points are mapped to mountPoints record; others go to customPaths.
 * Missing standard mount points are filled from DEFAULT_MOUNT_RULES.
 */
export function mountRuleEntriesToMountRules(entries: MountRuleEntry[]): MountRules {
  const standardSet = new Set<string>(STANDARD_MOUNT_POINT_IDS);
  const mountPoints: Partial<Record<StandardMountPointId, StandardMountPointRule>> = {};
  const customPaths: CustomMountPointRule[] = [];

  for (const entry of entries) {
    if (standardSet.has(entry.name)) {
      const mountPointId = entry.name as StandardMountPointId;
      const rule = validateStandardMountPointRule(entry);
      mountPoints[mountPointId] = rule ?? { ...DEFAULT_MOUNT_RULES.mountPoints[mountPointId], enabled: false };
    } else {
      if (entry.enabled !== true) continue;
      const rule = validateCustomMountPointRule({ alias: entry.name, path: entry.path });
      if (rule) customPaths.push(rule);
    }
  }
  // Fill missing standard mount points from defaults
  for (const id of STANDARD_MOUNT_POINT_IDS) {
    if (!mountPoints[id]) mountPoints[id] = { ...DEFAULT_MOUNT_RULES.mountPoints[id] };
  }
  return { version: 1, mountPoints: mountPoints as Record<StandardMountPointId, StandardMountPointRule>, customPaths };
}

export async function readProjectMountRulesOverride(projectRoot: string): Promise<MountRules | null> {
  const config = await readCapabilitiesConfig(projectRoot);
  if (config?.mountRules && Array.isArray(config.mountRules) && config.mountRules.length > 0) {
    return mountRuleEntriesToMountRules(config.mountRules);
  }
  return null;
}

async function readMainDefaultMountRules(mainProjectRoot?: string): Promise<MountRules | null> {
  if (!mainProjectRoot) return null;
  const mainConfig = await readCapabilitiesConfig(mainProjectRoot);
  if (
    mainConfig?.defaultMountRules &&
    Array.isArray(mainConfig.defaultMountRules) &&
    mainConfig.defaultMountRules.length > 0
  ) {
    return mountRuleEntriesToMountRules(mainConfig.defaultMountRules);
  }
  return null;
}

// ─── Primary read path ───────────────────────────────────────────

/**
 * Read mount rules for a project.
 *
 * Data source priority:
 * 1. capabilities.json#mountRules → adapter → MountRules
 * 2. Main project's defaultMountRules (when mainProjectRoot provided)
 * 3. DEFAULT_MOUNT_RULES
 *
 * Pass `mainProjectRoot` to enable defaultMountRules inheritance for
 * external projects that lack their own mountRules. All runtime callers
 * should pass this so defaultMountRules configured in the global panel
 * take effect.
 *
 * Returns MountRules (old shape) — all downstream consumers work unchanged.
 */
export async function readMountRules(projectRoot: string, mainProjectRoot?: string): Promise<MountRules> {
  const projectRules = await readProjectMountRulesOverride(projectRoot);
  if (projectRules) return projectRules;

  // F228: inherit from main project's defaultMountRules when this project
  // has no own mountRules. For the main project itself, defaultMountRules
  // is also the SCOPE_ALL policy unless an explicit own mountRules exists.
  const defaultRules = await readMainDefaultMountRules(mainProjectRoot);
  if (defaultRules) return defaultRules;

  return structuredClone(DEFAULT_MOUNT_RULES);
}

/**
 * Read effective mount rules with defaultMountRules inheritance.
 *
 * Resolution order:
 * 1. Project's own capabilities.json#mountRules → convert
 * 2. Main project's capabilities.json#defaultMountRules → convert
 * 3. DEFAULT_MOUNT_RULES
 */
export async function readEffectiveMountRules(projectRoot: string, mainProjectRoot: string): Promise<MountRules> {
  const projectRules = await readProjectMountRulesOverride(projectRoot);
  if (projectRules) return projectRules;

  const defaultRules = await readMainDefaultMountRules(mainProjectRoot);
  if (defaultRules) return defaultRules;

  return structuredClone(DEFAULT_MOUNT_RULES);
}

/**
 * Read global default mount rules from the main project's capabilities.json.
 * Returns DEFAULT_MOUNT_RULES when no defaultMountRules field is present.
 */
export async function readDefaultMountRules(mainProjectRoot: string): Promise<MountRules> {
  const config = await readCapabilitiesConfig(mainProjectRoot);
  if (config?.defaultMountRules && Array.isArray(config.defaultMountRules) && config.defaultMountRules.length > 0) {
    return mountRuleEntriesToMountRules(config.defaultMountRules);
  }
  return structuredClone(DEFAULT_MOUNT_RULES);
}

/**
 * Persist global default mount rules to the main project's capabilities.json.
 * This defines the fallback for external projects that lack their own mountRules.
 */
export async function writeDefaultMountRules(mainProjectRoot: string, rules: MountRules): Promise<void> {
  const config = await readCapabilitiesConfig(mainProjectRoot);
  if (!config) {
    throw new Error('Main project capabilities.json not found — cannot write defaultMountRules');
  }
  config.defaultMountRules = mountRulesToMountRuleEntries(rules);
  await writeCapabilitiesConfig(mainProjectRoot, config);
}

/**
 * Persist mount rules to capabilities.json#mountRules.
 * Creates a minimal v2 capabilities.json if none exists.
 */
export async function writeMountRules(projectRoot: string, rules: MountRules): Promise<void> {
  let config = await readCapabilitiesConfig(projectRoot);
  if (!config) {
    config = { version: 2, capabilities: [] } as CapabilitiesConfig;
  }
  config.mountRules = mountRulesToMountRuleEntries(rules);
  await writeCapabilitiesConfig(projectRoot, config);
}

export async function clearProjectMountRulesOverride(projectRoot: string): Promise<void> {
  const config = await readCapabilitiesConfig(projectRoot);
  if (config && 'mountRules' in config) {
    delete config.mountRules;
    await writeCapabilitiesConfig(projectRoot, config);
  }
}

/**
 * Validate untrusted input as MountRules.
 *
 * Returns null on any structural mismatch — required because the file is
 * user-editable and may be hand-broken. All four standard mount points must be
 * present (the schema guarantees this) and every customPath entry must have
 * a non-empty alias + path.
 */
export function validateMountRules(input: unknown): MountRules | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1) return null;

  const mountPointsRaw = obj.mountPoints;
  if (!mountPointsRaw || typeof mountPointsRaw !== 'object') return null;
  const mountPointsObj = mountPointsRaw as Record<string, unknown>;

  const validatedMountPoints: Partial<Record<StandardMountPointId, StandardMountPointRule>> = {};
  for (const id of STANDARD_MOUNT_POINT_IDS) {
    const entry = validateStandardMountPointRule(mountPointsObj[id]);
    if (!entry) return null;
    validatedMountPoints[id] = entry;
  }

  // Custom paths may be absent in older input — treat missing as [].
  const customPaths = obj.customPaths;
  if (customPaths !== undefined && !Array.isArray(customPaths)) return null;
  const validatedCustomPaths: CustomMountPointRule[] = [];
  const customAliases = new Set<string>();
  for (const cp of customPaths ?? []) {
    const entry = validateCustomMountPointRule(cp);
    if (!entry) return null;
    if (customAliases.has(entry.alias)) return null;
    customAliases.add(entry.alias);
    validatedCustomPaths.push(entry);
  }

  return {
    version: 1,
    mountPoints: validatedMountPoints as Record<StandardMountPointId, StandardMountPointRule>,
    customPaths: validatedCustomPaths,
  };
}
