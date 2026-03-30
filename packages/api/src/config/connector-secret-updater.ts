import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyEnvUpdatesToFile } from '../routes/config.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { configEventBus, createChangeSetId } from './config-event-bus.js';

export interface ConnectorSecretUpdate {
  name: string;
  value: string | null;
}

export interface ConnectorSecretUpdaterOptions {
  envFilePath?: string;
}

export async function applyConnectorSecretUpdates(
  updates: ConnectorSecretUpdate[],
  opts: ConnectorSecretUpdaterOptions = {},
): Promise<{ changedKeys: string[] }> {
  const envFilePath = opts.envFilePath ?? resolve(resolveActiveProjectRoot(), '.env');
  const updatesMap = new Map<string, string | null>(updates.map((update) => [update.name, update.value]));

  const oldValues = new Map<string, string | undefined>();
  for (const name of updatesMap.keys()) {
    oldValues.set(name, process.env[name]);
  }

  const current = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : '';
  const next = applyEnvUpdatesToFile(current, updatesMap);
  writeFileSync(envFilePath, next, 'utf8');

  for (const [name, value] of updatesMap) {
    if (value == null || value === '') delete process.env[name];
    else process.env[name] = value;
  }

  const changedKeys = [...updatesMap.entries()]
    .filter(([name, value]) => (value ?? '') !== (oldValues.get(name) ?? ''))
    .map(([name]) => name);

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
