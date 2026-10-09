import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginManifest } from '@cat-cafe/shared';
import { configEventBus, createChangeSetId } from '../../config/config-event-bus.js';
import type { OperationState } from './operations/operation-state-machine.js';

const CONFIG_DIR = '.cat-cafe';
const PLUGIN_CONFIG_SUBDIR = 'plugin-config';

const configCache = new Map<string, StoredValues>();

function resolvePluginConfigDir(projectRoot: string): string {
  return resolve(projectRoot, CONFIG_DIR, PLUGIN_CONFIG_SUBDIR);
}

function resolvePluginConfigPath(projectRoot: string, pluginId: string): string {
  return resolve(resolvePluginConfigDir(projectRoot), `${pluginId}.json`);
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

type StoredValues = Record<string, string | null>;
type StoredDocument = Record<string, unknown>;

const OPERATIONS_KEY = '_operations';

function readRawConfig(projectRoot: string, pluginId: string): StoredDocument {
  const configPath = resolvePluginConfigPath(projectRoot, pluginId);
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: StoredDocument = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') result[k] = v;
      else if (v === null) result[k] = null;
      else if (k === OPERATIONS_KEY && typeof v === 'object' && v !== null && !Array.isArray(v)) {
        result[k] = structuredClone(v);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function storedValues(document: StoredDocument): StoredValues {
  const values: StoredValues = {};
  for (const [key, value] of Object.entries(document)) {
    if (typeof value === 'string' || value === null) values[key] = value;
  }
  return values;
}

export function readPluginConfig(projectRoot: string, pluginId: string): Record<string, string> {
  const raw = readRawConfig(projectRoot, pluginId);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') result[k] = v;
  }
  return result;
}

function operationState(value: unknown): OperationState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.currentAction !== 'string' || raw.currentAction.length === 0) return undefined;
  if (raw.updatedAt !== undefined && (!Number.isSafeInteger(raw.updatedAt) || (raw.updatedAt as number) < 0)) {
    return undefined;
  }
  const lastResult =
    typeof raw.lastResult === 'object' && raw.lastResult !== null && !Array.isArray(raw.lastResult)
      ? (() => {
          const result = raw.lastResult as Record<string, unknown>;
          return typeof result.render === 'string' && Object.hasOwn(result, 'data')
            ? {
                render: result.render,
                data: structuredClone(result.data),
                ...(typeof result.label === 'string' ? { label: result.label } : {}),
              }
            : undefined;
        })()
      : undefined;
  return {
    currentAction: raw.currentAction,
    ...(raw.updatedAt === undefined ? {} : { updatedAt: raw.updatedAt as number }),
    ...(lastResult === undefined ? {} : { lastResult }),
  };
}

export function readPluginOperationState(
  projectRoot: string,
  pluginId: string,
  operationKey: string,
): OperationState | undefined {
  const raw = readRawConfig(projectRoot, pluginId)[OPERATIONS_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  return operationState((raw as Record<string, unknown>)[operationKey]);
}

export function writePluginOperationState(
  projectRoot: string,
  pluginId: string,
  operationKey: string,
  state: OperationState | undefined,
): void {
  const document = readRawConfig(projectRoot, pluginId);
  const previous = document[OPERATIONS_KEY];
  const operations =
    typeof previous === 'object' && previous !== null && !Array.isArray(previous)
      ? { ...(previous as Record<string, unknown>) }
      : {};
  if (state === undefined) delete operations[operationKey];
  else operations[operationKey] = structuredClone(state);
  if (Object.keys(operations).length === 0) delete document[OPERATIONS_KEY];
  else document[OPERATIONS_KEY] = operations;

  const dir = resolvePluginConfigDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(resolvePluginConfigPath(projectRoot, pluginId), `${JSON.stringify(document, null, 2)}\n`);
}

export function writePluginConfig(
  projectRoot: string,
  pluginId: string,
  updates: { name: string; value: string | null }[],
): { changedKeys: string[] } {
  const dir = resolvePluginConfigDir(projectRoot);
  mkdirSync(dir, { recursive: true });

  const existing = readRawConfig(projectRoot, pluginId);
  const changedKeys: string[] = [];

  for (const { name, value } of updates) {
    const oldVal = existing[name] ?? '';
    const newVal = value ?? '';
    if (oldVal !== newVal) changedKeys.push(name);

    if (value == null || value === '') {
      existing[name] = null;
    } else {
      existing[name] = value;
    }
  }

  const configPath = resolvePluginConfigPath(projectRoot, pluginId);
  writeFileAtomic(configPath, `${JSON.stringify(existing, null, 2)}\n`);

  configCache.set(pluginId, readPluginConfig(projectRoot, pluginId));

  if (changedKeys.length > 0) {
    configEventBus.emitChange({
      source: 'secrets',
      scope: 'key',
      changedKeys,
      changeSetId: createChangeSetId(),
      timestamp: Date.now(),
    });
  }

  return { changedKeys };
}

export function loadAllPluginConfigs(projectRoot: string, manifests: PluginManifest[]): number {
  let loaded = 0;
  for (const manifest of manifests) {
    const allowedEnvNames = new Set(manifest.config.map((f) => f.envName));
    const raw = storedValues(readRawConfig(projectRoot, manifest.id));
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

function projectPluginEnv(
  manifests: PluginManifest[],
  valuesForManifest: (manifest: PluginManifest) => StoredValues | undefined,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const manifest of manifests) {
    const values = valuesForManifest(manifest);
    for (const field of manifest.config) {
      const fromStore = values?.[field.envName];
      if (typeof fromStore === 'string') {
        result[field.envName] = fromStore;
      } else if (fromStore === null) {
        result[field.envName] = undefined;
      } else {
        const fromEnv = process.env[field.envName];
        if (fromEnv) result[field.envName] = fromEnv;
      }
    }
  }
  return result;
}

/** Reads current persisted values for UI projection without replacing the live runtime cache. */
export function readPluginEnvSnapshot(
  projectRoot: string,
  manifests: PluginManifest[],
): Record<string, string | undefined> {
  return projectPluginEnv(manifests, (manifest) => storedValues(readRawConfig(projectRoot, manifest.id)));
}

export function resolvePluginEnv(manifests: PluginManifest[]): Record<string, string | undefined> {
  return projectPluginEnv(manifests, (manifest) => configCache.get(manifest.id));
}
