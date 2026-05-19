import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { ServiceConfig } from './service-manifest.js';

function resolveConfigPath(): string {
  return process.env.CAT_CAFE_SERVICES_CONFIG
    ? resolve(process.env.CAT_CAFE_SERVICES_CONFIG)
    : resolve(homedir(), '.cat-cafe/services.json');
}

type ServiceConfigMap = Record<string, ServiceConfig>;

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
    cache = JSON.parse(readFileSync(configPath, 'utf-8')) as ServiceConfigMap;
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
