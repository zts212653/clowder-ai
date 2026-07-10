import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceConfig } from './service-manifest.js';

function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

function resolveDefaultCatCafeHome(): string {
  const raw = process.env.CAT_CAFE_HOME?.trim();
  if (raw) return expandHomePath(raw);
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../../..', '.cat-cafe');
}

function resolveConfigPath(): string {
  return process.env.CAT_CAFE_SERVICES_CONFIG
    ? resolve(process.env.CAT_CAFE_SERVICES_CONFIG)
    : resolve(resolveDefaultCatCafeHome(), 'services.json');
}

type ServiceConfigMap = Record<string, ServiceConfig>;

/**
 * Legacy service IDs that were merged into a current service (#863).
 * On first load, any persisted config under the old key is migrated to the
 * new key so that existing users don't lose their installed/enabled state.
 */
const LEGACY_SERVICE_ALIASES: Record<string, string> = {
  'qwen3-asr': 'whisper-stt',
};

function migrateServiceConfig(data: ServiceConfigMap): boolean {
  let changed = false;
  for (const [oldId, newId] of Object.entries(LEGACY_SERVICE_ALIASES)) {
    if (data[oldId] != null) {
      if (data[newId] == null) {
        // Preserve enabled/model/port but force reinstall — the old
        // service used a different venv path (e.g. asr-venv vs whisper-venv)
        // so the installed state is stale (#863).
        const { installed: _, ...migrated } = data[oldId];
        data[newId] = migrated;
      }
      delete data[oldId];
      changed = true;
    }
  }
  return changed;
}

let cachePath: string | null = null;
let cache: ServiceConfigMap | null = null;

function load(): ServiceConfigMap {
  const configPath = resolveConfigPath();
  if (cachePath === configPath && cache) return cache;
  cachePath = configPath;
  if (!existsSync(configPath)) {
    cache = {};
    return cache;
  }
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8')) as ServiceConfigMap;
    if (migrateServiceConfig(data)) {
      save(data);
    }
    cache = data;
    return cache;
  } catch {
    cache = {};
    return cache;
  }
}

function save(data: ServiceConfigMap): void {
  const configPath = resolveConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
  cachePath = configPath;
  cache = data;
}

export function getServiceConfig(id: string): ServiceConfig | undefined {
  const all = load();
  return all[id];
}

export function setServiceConfig(id: string, patch: Partial<ServiceConfig>): ServiceConfig {
  const all = load();
  const current = all[id] ?? { enabled: false, installStatus: 'none' };
  const updated = { ...current, ...patch };
  all[id] = updated;
  save(all);
  return updated;
}
