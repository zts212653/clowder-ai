/**
 * IM Connector Config Store — persistent config in `.cat-cafe/im-connector-config/`
 *
 * Resolution order: stored value (Hub UI write) > env var > YAML default.
 * This means users who already have env vars configured get seamless migration.
 *
 * F240 KD-15/KD-18: uses shared ValueConfigField types.
 * Defaults encoded through codec (toggle→"true"/"false", list→JSON array string).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValueField, type OperationState, type ValueConfigField } from '@cat-cafe/shared';
import { encodeDefault } from '../config-field-parser.js';
import type { ConnectorManifest } from './plugins/im-connector-manifest.js';

const CONFIG_DIR = '.cat-cafe';
const CONNECTOR_CONFIG_SUBDIR = 'im-connector-config';
const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

type StoredValues = Record<string, string | null>;

const configCache = new Map<string, StoredValues>();

function assertValidConnectorId(connectorId: string): void {
  if (
    connectorId.length < 1 ||
    connectorId.length > 64 ||
    !CONNECTOR_ID_PATTERN.test(connectorId) ||
    connectorId.includes('--')
  ) {
    throw new Error(`Invalid connector ID '${connectorId}': must be lowercase alphanumeric with hyphens, 1-64 chars`);
  }
}

function resolveConfigDir(projectRoot: string): string {
  return resolve(projectRoot, CONFIG_DIR, CONNECTOR_CONFIG_SUBDIR);
}

function resolveConfigPath(projectRoot: string, connectorId: string): string {
  assertValidConnectorId(connectorId);
  return resolve(resolveConfigDir(projectRoot), `${connectorId}.json`);
}

function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw error;
  }
}

/**
 * Read the full JSON config including `_operations` namespace.
 * Used by both value-field and operation-state paths.
 */
function readFullConfig(projectRoot: string, connectorId: string): Record<string, unknown> {
  const configPath = resolveConfigPath(projectRoot, connectorId);
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Extract only value fields (string | null) from full config, skipping _operations. */
function extractValueFields(full: Record<string, unknown>): StoredValues {
  const result: StoredValues = {};
  for (const [k, v] of Object.entries(full)) {
    if (k === '_operations') continue;
    if (typeof v === 'string') result[k] = v;
    else if (v === null) result[k] = null;
  }
  return result;
}

function readRawConfig(projectRoot: string, connectorId: string): StoredValues {
  return extractValueFields(readFullConfig(projectRoot, connectorId));
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Read stored config for a connector (raw, no env fallback).
 */
export function readConnectorConfig(projectRoot: string, connectorId: string): Record<string, string> {
  const raw = readRawConfig(projectRoot, connectorId);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') result[k] = v;
  }
  return result;
}

/**
 * Write config updates for a connector.
 * Returns the list of keys that actually changed.
 */
export function writeConnectorConfig(
  projectRoot: string,
  connectorId: string,
  updates: { name: string; value: string | null }[],
): { changedKeys: string[] } {
  const dir = resolveConfigDir(projectRoot);
  mkdirSync(dir, { recursive: true });

  // Read full config to preserve _operations namespace (AC-A20)
  const full = readFullConfig(projectRoot, connectorId);
  const values = extractValueFields(full);
  const changedKeys: string[] = [];

  for (const { name, value } of updates) {
    // Three-state comparison (KD-19): undefined → null is a real change
    // (tombstone creation), null → null is idempotent (no change).
    // Previous `?? ''` collapsed undefined and null, masking tombstone writes.
    const oldRaw = values[name]; // undefined | null | string
    const newRaw = value == null || value === '' ? null : value; // null | string
    if (oldRaw !== newRaw) changedKeys.push(name);

    if (value == null || value === '') {
      values[name] = null;
    } else {
      values[name] = value;
    }
  }

  // Merge value fields back with preserved _operations
  const merged: Record<string, unknown> = { ...values };
  if (full._operations !== undefined) merged._operations = full._operations;

  const configPath = resolveConfigPath(projectRoot, connectorId);
  writeFileAtomic(configPath, `${JSON.stringify(merged, null, 2)}\n`);

  configCache.set(connectorId, { ...values });

  return { changedKeys };
}

/**
 * Load all connector configs into cache on startup.
 * KD-17: only value fields have envName — filter out operations before extracting.
 */
export function loadAllConnectorConfigs(
  projectRoot: string,
  manifests: Pick<ConnectorManifest, 'id' | 'config'>[],
): number {
  let loaded = 0;
  for (const manifest of manifests) {
    const valueFields = manifest.config.filter(isValueField);
    const allowedEnvNames = new Set(valueFields.map((f) => f.envName));
    const raw = readRawConfig(projectRoot, manifest.id);
    const filtered: StoredValues = {};
    for (const [name, value] of Object.entries(raw)) {
      if (!allowedEnvNames.has(name)) continue;
      filtered[name] = value;
      if (typeof value === 'string') loaded++;
    }
    configCache.set(manifest.id, filtered);
  }
  return loaded;
}

/**
 * Resolve the effective env for a connector.
 * Priority: stored value > process.env > YAML default.
 *
 * KD-17: only accepts ValueConfigField[] (env-backed fields).
 * KD-18: defaults encoded through codec (toggle "true"/"false", list JSON array).
 */
export function resolveConnectorEnv(
  connectorId: string,
  fields: readonly ValueConfigField[],
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  const cached = configCache.get(connectorId);

  for (const field of fields) {
    // 1. Stored value (from .cat-cafe/ config)
    const fromStore = cached?.[field.envName];
    if (typeof fromStore === 'string') {
      result[field.envName] = fromStore;
      continue;
    }

    // 1b. Tombstone — stored null means user explicitly cleared this field.
    // Block env fallback to prevent .env resurrection (KD-19 AC-A8a).
    if (fromStore === null) {
      result[field.envName] = undefined;
      continue;
    }

    // 2. Environment variable (legacy / .env fallback)
    // Only reached when key is absent from store (never written or file missing).
    const fromEnv = process.env[field.envName];
    if (fromEnv) {
      result[field.envName] = fromEnv;
      continue;
    }

    // 3. YAML default — encode through codec per KD-18 string contract
    // toggle default: false → "false", list default: [] → "[]"
    const encoded = encodeDefault(field);
    if (encoded != null) {
      result[field.envName] = encoded;
      continue;
    }

    // Not set
    result[field.envName] = undefined;
  }

  return result;
}

/**
 * Get a single stored value from the config cache.
 * Three-state return per KD-19 tombstone semantics:
 * - `string`    → stored value (user wrote via Hub)
 * - `null`      → tombstone (user explicitly cleared in Hub — blocks fallback)
 * - `undefined` → absent (never written — safe to fall through to env/default)
 */
export function getStoredConnectorValue(connectorId: string, envName: string): string | null | undefined {
  const cached = configCache.get(connectorId);
  if (!cached) return undefined;
  if (!(envName in cached)) return undefined;
  return cached[envName]; // string | null
}

// ── Operation state (AC-A20) ────────────────────────────────────────

/**
 * Read persisted operation state for one operation within a connector.
 * Returns undefined if connector or operation not found.
 */
export function readOperationState(
  projectRoot: string,
  connectorId: string,
  operationName: string,
): OperationState | undefined {
  const full = readFullConfig(projectRoot, connectorId);
  const ops = full._operations;
  if (typeof ops !== 'object' || ops === null || Array.isArray(ops)) return undefined;
  const state = (ops as Record<string, unknown>)[operationName];
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return undefined;
  const s = state as Record<string, unknown>;
  if (typeof s.currentAction !== 'string') return undefined;
  const result: OperationState = { currentAction: s.currentAction };
  if (s.lastResult && typeof s.lastResult === 'object') {
    result.lastResult = s.lastResult as OperationState['lastResult'];
  }
  if (typeof s.updatedAt === 'number') {
    result.updatedAt = s.updatedAt;
  }
  return result;
}

/**
 * Write operation state for one operation. Creates `_operations` namespace if absent.
 * Preserves value fields and other operations in the same JSON file.
 */
export function writeOperationState(
  projectRoot: string,
  connectorId: string,
  operationName: string,
  state: OperationState,
  options: { preserveUpdatedAt?: boolean } = {},
): void {
  const dir = resolveConfigDir(projectRoot);
  mkdirSync(dir, { recursive: true });

  const full = readFullConfig(projectRoot, connectorId);
  const existingOps =
    typeof full._operations === 'object' && full._operations !== null && !Array.isArray(full._operations)
      ? { ...(full._operations as Record<string, unknown>) }
      : {};
  const existingState = existingOps[operationName];
  const existingUpdatedAt =
    typeof existingState === 'object' &&
    existingState !== null &&
    !Array.isArray(existingState) &&
    typeof (existingState as Record<string, unknown>).updatedAt === 'number'
      ? ((existingState as Record<string, unknown>).updatedAt as number)
      : undefined;
  existingOps[operationName] = {
    ...state,
    updatedAt: options.preserveUpdatedAt && existingUpdatedAt !== undefined ? existingUpdatedAt : Date.now(),
  };
  full._operations = existingOps;

  const configPath = resolveConfigPath(projectRoot, connectorId);
  writeFileAtomic(configPath, `${JSON.stringify(full, null, 2)}\n`);
}

/**
 * Read all persisted operation states for a connector.
 * Returns empty object if connector not found or no operations stored.
 */
export function readAllOperationStates(projectRoot: string, connectorId: string): Record<string, OperationState> {
  const full = readFullConfig(projectRoot, connectorId);
  const ops = full._operations;
  if (typeof ops !== 'object' || ops === null || Array.isArray(ops)) return {};
  const result: Record<string, OperationState> = {};
  for (const [name, state] of Object.entries(ops as Record<string, unknown>)) {
    if (typeof state !== 'object' || state === null || Array.isArray(state)) continue;
    const s = state as Record<string, unknown>;
    if (typeof s.currentAction !== 'string') continue;
    const entry: OperationState = { currentAction: s.currentAction };
    if (s.lastResult && typeof s.lastResult === 'object') {
      entry.lastResult = s.lastResult as OperationState['lastResult'];
    }
    if (typeof s.updatedAt === 'number') {
      entry.updatedAt = s.updatedAt;
    }
    result[name] = entry;
  }
  return result;
}

/**
 * Clear the in-memory cache. Mainly for testing.
 */
export function clearConnectorConfigCache(): void {
  configCache.clear();
}
