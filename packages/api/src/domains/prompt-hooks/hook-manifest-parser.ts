/**
 * Hook Manifest Parser — F237 Phase 2
 *
 * Parses and validates hook.yaml manifest files.
 * Modeled on plugin-manifest.ts pattern (F202).
 */

import { readFileSync } from 'node:fs';
import type { GovernanceTier, HookManifest, HookStage, SafetyTier, TransparencyTier } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Valid enum values
// ---------------------------------------------------------------------------

const VALID_STAGES: ReadonlySet<HookStage> = new Set(['session-init', 'per-turn']);
const VALID_SAFETY_TIERS: ReadonlySet<SafetyTier> = new Set(['readonly', 'limited-edit', 'editable']);
const VALID_TRANSPARENCY_TIERS: ReadonlySet<TransparencyTier> = new Set([
  'visible-by-default',
  'opt-in-view',
  'debug-only',
]);
const VALID_GOVERNANCE_TIERS: ReadonlySet<GovernanceTier> = new Set(['immutable', 'human-gated', 'auto-evolve']);

// ---------------------------------------------------------------------------
// Hook ID pattern: letter(s) + number(s), e.g. S1, D21, L7, B1, C1, R2, N1
// ---------------------------------------------------------------------------

const HOOK_ID_PATTERN = /^[A-Z]+\d+$/;

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

export interface HookManifestParseResult {
  ok: boolean;
  manifest?: HookManifest;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseHookManifest(yamlPath: string): HookManifestParseResult {
  const errors: string[] = [];

  let raw: string;
  try {
    raw = readFileSync(yamlPath, 'utf-8');
  } catch (err) {
    return { ok: false, errors: [`Cannot read ${yamlPath}: ${err}`] };
  }

  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(raw) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, errors: [`Invalid YAML in ${yamlPath}: ${err}`] };
  }

  if (!doc || typeof doc !== 'object') {
    return { ok: false, errors: [`${yamlPath}: expected object, got ${typeof doc}`] };
  }

  // Required string fields
  const id = requireString(doc, 'id', errors);
  const name = requireString(doc, 'name', errors);
  const template = requireString(doc, 'template', errors);

  // Required enum fields
  const stage = requireEnum(doc, 'stage', VALID_STAGES, errors) as HookStage;
  const safetyTier = requireEnum(doc, 'safetyTier', VALID_SAFETY_TIERS, errors) as SafetyTier;
  const transparencyTier = requireEnum(doc, 'transparencyTier', VALID_TRANSPARENCY_TIERS, errors) as TransparencyTier;
  const governanceTier = requireEnum(doc, 'governanceTier', VALID_GOVERNANCE_TIERS, errors) as GovernanceTier;

  // Required numeric fields
  const order = requireNumber(doc, 'order', errors);
  const version = requireNumber(doc, 'version', errors);

  // Required boolean fields
  const enabled = requireBoolean(doc, 'enabled', errors);
  const disableable = requireBoolean(doc, 'disableable', errors);

  // Optional fields
  const resolver = typeof doc.resolver === 'string' ? doc.resolver : undefined;
  const userExplanation = typeof doc.userExplanation === 'string' ? doc.userExplanation : undefined;

  // Inputs array
  const inputs = requireStringArray(doc, 'inputs', errors);

  // ID format validation
  if (id && !HOOK_ID_PATTERN.test(id)) {
    errors.push(`id '${id}' does not match pattern ${HOOK_ID_PATTERN}`);
  }

  // Order range validation
  if (typeof order === 'number' && order < 0) {
    errors.push(`order must be non-negative, got ${order}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    manifest: {
      id: id as string,
      name: name as string,
      stage: stage as HookStage,
      order: order as number,
      version: version as number,
      enabled: enabled as boolean,
      template: template as string,
      resolver,
      inputs: inputs as string[],
      disableable: disableable as boolean,
      safetyTier: safetyTier as SafetyTier,
      transparencyTier: transparencyTier as TransparencyTier,
      governanceTier: governanceTier as GovernanceTier,
      userExplanation,
    },
  };
}

// ---------------------------------------------------------------------------
// Field extraction helpers
// ---------------------------------------------------------------------------

function requireString(doc: Record<string, unknown>, field: string, errors: string[]): string | undefined {
  const val = doc[field];
  if (typeof val !== 'string' || val.length === 0) {
    errors.push(`'${field}' must be a non-empty string`);
    return undefined;
  }
  return val;
}

function requireNumber(doc: Record<string, unknown>, field: string, errors: string[]): number | undefined {
  const val = doc[field];
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    errors.push(`'${field}' must be a finite number`);
    return undefined;
  }
  return val;
}

function requireBoolean(doc: Record<string, unknown>, field: string, errors: string[]): boolean | undefined {
  const val = doc[field];
  if (typeof val !== 'boolean') {
    errors.push(`'${field}' must be a boolean`);
    return undefined;
  }
  return val;
}

function requireEnum<T extends string>(
  doc: Record<string, unknown>,
  field: string,
  valid: ReadonlySet<T>,
  errors: string[],
): T | undefined {
  const val = doc[field];
  if (typeof val !== 'string' || !valid.has(val as T)) {
    errors.push(`'${field}' must be one of: ${[...valid].join(', ')}`);
    return undefined;
  }
  return val as T;
}

function requireStringArray(doc: Record<string, unknown>, field: string, errors: string[]): string[] | undefined {
  const val = doc[field];
  if (!Array.isArray(val)) {
    errors.push(`'${field}' must be an array`);
    return undefined;
  }
  if (!val.every((item: unknown) => typeof item === 'string')) {
    errors.push(`'${field}' must contain only strings`);
    return undefined;
  }
  return val as string[];
}
