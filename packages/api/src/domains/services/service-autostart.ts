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

  const enabled = services.filter((m) => configs[m.id]?.enabled);
  if (enabled.length === 0) {
    log.info('[services] No services enabled');
    return;
  }

  log.info('[services] %d service(s) enabled: %s', enabled.length, enabled.map((m) => m.name).join(', '));

  for (const manifest of enabled) {
    const cfg = configs[manifest.id]!;
    if (!manifest.scripts.start) continue;
    if (!checkInstalled(manifest)) {
      log.warn('[services] ✗ %s — enabled but not installed (run install from Settings)', manifest.name);
      continue;
    }

    const state = await getServiceState(manifest);
    if (state.status === 'running' || state.status === 'starting') {
      log.info('[services] ✓ %s — already running (port %s)', manifest.name, manifest.port ?? '?');
      continue;
    }

    const scriptPath = resolve(REPO_ROOT, manifest.scripts.start);
    if (!existsSync(scriptPath)) {
      log.warn('[services] ✗ %s — start script not found: %s', manifest.name, manifest.scripts.start);
      continue;
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (cfg.selectedModel) {
      const envKey = MODEL_ENV_VARS[manifest.id];
      if (envKey) env[envKey] = cfg.selectedModel;
    }

    log.info('[services] ⟳ %s — starting (port %s)...', manifest.name, manifest.port ?? '?');
    try {
      const child = spawn('bash', [scriptPath], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.on('error', () => {});
      child.unref();
    } catch {
      log.warn('[services] ✗ %s — failed to spawn start script', manifest.name);
    }
  }
}
