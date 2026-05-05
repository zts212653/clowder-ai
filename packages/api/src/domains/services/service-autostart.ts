import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllServiceConfigs } from './service-config.js';
import { MODEL_ENV_VARS } from './service-manifest.js';
import { checkInstalled, getKnownServices, getServiceState } from './service-registry.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
}

export async function autoStartEnabledServices(log: Logger): Promise<void> {
  const configs = getAllServiceConfigs();
  const services = getKnownServices();

  for (const manifest of services) {
    const cfg = configs[manifest.id];
    if (!cfg?.enabled) continue;
    if (!manifest.scripts.start) continue;
    if (!checkInstalled(manifest)) {
      log.warn('[services] %s is enabled but not installed — skipping auto-start', manifest.name);
      continue;
    }

    const state = await getServiceState(manifest);
    if (state.status === 'running' || state.status === 'starting') continue;

    const scriptPath = resolve(REPO_ROOT, manifest.scripts.start);
    if (!existsSync(scriptPath)) continue;

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (cfg.selectedModel) {
      const envKey = MODEL_ENV_VARS[manifest.id];
      if (envKey) env[envKey] = cfg.selectedModel;
    }

    log.info('[services] Auto-starting %s ...', manifest.name);
    try {
      const child = spawn('bash', [scriptPath], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.on('error', () => {});
      child.unref();
    } catch {
      log.warn('[services] Failed to auto-start %s', manifest.name);
    }
  }
}
