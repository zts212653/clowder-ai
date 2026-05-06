import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const DEFAULT_API_PORT = '3004';
const DEFAULT_WEB_PORT = '3003';

export function pidIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    return false;
  }
}

export function readDotEnvValues(dotEnvPath) {
  if (!existsSync(dotEnvPath)) return {};

  const values = {};
  for (const rawLine of readFileSync(dotEnvPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

function resolvePortValue(dotEnv, env, key, defaultValue) {
  const dotEnvValue = dotEnv[key];
  if (dotEnvValue !== undefined && dotEnvValue !== '') return dotEnvValue;

  const envValue = env[key];
  if (envValue !== undefined && envValue !== '') return envValue;

  return defaultValue;
}

export function resolveWindowsStatusPorts({ projectRoot = process.cwd(), env = process.env } = {}) {
  const dotEnv = readDotEnvValues(resolve(projectRoot, '.env'));
  return {
    apiPort: resolvePortValue(dotEnv, env, 'API_SERVER_PORT', DEFAULT_API_PORT),
    webPort: resolvePortValue(dotEnv, env, 'FRONTEND_PORT', DEFAULT_WEB_PORT),
  };
}

export function buildWindowsStatus({
  projectRoot = process.cwd(),
  env = process.env,
  pidIsRunning: checkPid = pidIsRunning,
} = {}) {
  const runDir = resolve(projectRoot, '.cat-cafe', 'run', 'windows');
  if (!existsSync(runDir)) {
    return {
      exitCode: 1,
      lines: [`Cat Cafe Windows services not running (no run directory: ${runDir})`],
    };
  }

  const { apiPort, webPort } = resolveWindowsStatusPorts({ projectRoot, env });
  const requiredServices = [
    { pidFile: `api-${apiPort}.pid`, running: false },
    { pidFile: `web-${webPort}.pid`, running: false },
  ];

  const lines = ['Cat Cafe Windows status'];
  for (const service of requiredServices) {
    const pidPath = resolve(runDir, service.pidFile);
    const label = basename(service.pidFile, '.pid');
    if (!existsSync(pidPath)) {
      lines.push(`  ${label}: not running (missing PID file)`);
      continue;
    }

    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (Number.isNaN(pid)) {
      lines.push(`  ${label}: invalid PID file`);
      continue;
    }

    service.running = checkPid(pid);
    lines.push(`  ${label}: ${service.running ? 'running' : 'not running'} (PID: ${pid})`);
  }

  return {
    exitCode: requiredServices.every((service) => service.running) ? 0 : 1,
    lines,
  };
}

export function runWindowsStatus(options = {}) {
  const result = buildWindowsStatus(options);
  for (const line of result.lines) {
    console.log(line);
  }
  process.exit(result.exitCode);
}
