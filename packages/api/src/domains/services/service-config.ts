import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceConfig } from './service-manifest.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const CONFIG_PATH = process.env.CAT_CAFE_SERVICES_CONFIG
  ? resolve(process.env.CAT_CAFE_SERVICES_CONFIG)
  : resolve(REPO_ROOT, '.cat-cafe/services.json');

type ServiceConfigMap = Record<string, ServiceConfig>;

let cache: ServiceConfigMap | null = null;

function load(): ServiceConfigMap {
  if (cache) return cache;
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    cache = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as ServiceConfigMap;
    return cache!;
  } catch {
    return {};
  }
}

function save(data: ServiceConfigMap): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`);
  cache = data;
}

export function getServiceConfig(id: string): ServiceConfig {
  const all = load();
  return all[id] ?? { enabled: false };
}

export function setServiceConfig(id: string, patch: Partial<ServiceConfig>): ServiceConfig {
  const all = load();
  const current = all[id] ?? { enabled: false };
  const updated = { ...current, ...patch };
  all[id] = updated;
  save(all);
  return updated;
}

export function getAllServiceConfigs(): ServiceConfigMap {
  return load();
}
