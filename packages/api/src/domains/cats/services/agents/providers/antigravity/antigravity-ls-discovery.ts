import { execSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { platform as osPlatform } from 'node:os';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { BridgeConnection } from './AntigravityBridge.js';

const log = createModuleLogger('antigravity-discovery');

export interface LSProcessInfo {
  pid: string;
  cmd: string;
}

export interface DiscoveryDeps {
  platform?: NodeJS.Platform;
  listProcesses?: () => LSProcessInfo[];
  listListenPorts?: (pid: string) => number[];
  probe?: (conn: BridgeConnection) => Promise<void>;
}

function defaultProbe(conn: BridgeConnection): Promise<void> {
  const mod = conn.useTls ? https : http;
  const protocol = conn.useTls ? 'https' : 'http';
  const url = `${protocol}://127.0.0.1:${conn.port}/exa.language_server_pb.LanguageServerService/GetUserStatus`;
  const body = '{}';

  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-codeium-csrf-token': conn.csrfToken,
        },
        rejectUnauthorized: false,
        timeout: 5_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          res.statusCode === 200 ? resolve() : reject(new Error(`${res.statusCode}: ${data.slice(0, 100)}`));
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('probe timeout'));
    });
    req.write(body);
    req.end();
  });
}

export function listProcessesViaPs(): LSProcessInfo[] {
  let out = '';
  try {
    out = execSync('ps -eo pid,args 2>/dev/null | grep language_server | grep csrf_token | grep -v grep', {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
  } catch (err) {
    log.warn(`ps lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  if (!out) return [];

  const result: LSProcessInfo[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) result.push({ pid: m[1], cmd: m[2] });
  }
  return result;
}

export function listListenPortsViaLsof(pid: string): number[] {
  let out = '';
  try {
    out = execSync(`lsof -a -iTCP -sTCP:LISTEN -P -n -p ${pid} 2>/dev/null | grep LISTEN`, {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
  } catch (err) {
    log.warn(`lsof lookup failed for pid=${pid}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  if (!out) return [];

  const ports: number[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/:(\d+)\s/);
    if (m) {
      const port = Number(m[1]);
      if (Number.isFinite(port)) ports.push(port);
    }
  }
  return ports;
}

export function parseProcessesJson(raw: string): LSProcessInfo[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const result: LSProcessInfo[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const pid = obj.pid;
    const cmd = obj.cmd;
    if ((typeof pid === 'number' || typeof pid === 'string') && typeof cmd === 'string') {
      result.push({ pid: String(pid), cmd });
    }
  }
  return result;
}

function coerceFinitePort(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function parsePortsJson(raw: string): number[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const result: number[] = [];
  for (const v of candidates) {
    const port = coerceFinitePort(v);
    if (port !== null) result.push(port);
  }
  return result;
}

const PS_LIST_PROCESSES_SCRIPT = [
  'Get-CimInstance Win32_Process -Filter "Name LIKE \'%language_server%\'"',
  "Where-Object { $_.CommandLine -and $_.CommandLine -match 'csrf_token' }",
  "Select-Object @{Name='pid';Expression={$_.ProcessId}},@{Name='cmd';Expression={$_.CommandLine}}",
  'ConvertTo-Json -Compress',
].join(' | ');

function runPowerShell(script: string): string | null {
  // spawnSync with argv array bypasses cmd.exe entirely, avoiding the
  // quoting hell that broke -Filter "Name LIKE '%x%'" via execSync.
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) {
    log.warn(`PowerShell spawn failed: ${result.error.message}`);
    return null;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').toString().trim();
    log.warn(`PowerShell exited ${result.status}: ${stderr.slice(0, 200)}`);
    return null;
  }
  return (result.stdout ?? '').toString().trim();
}

export function listProcessesViaPowerShell(): LSProcessInfo[] {
  const out = runPowerShell(PS_LIST_PROCESSES_SCRIPT);
  return out ? parseProcessesJson(out) : [];
}

export function listListenPortsViaPowerShell(pid: string): number[] {
  if (!/^\d+$/.test(pid)) {
    log.warn(`refusing to query ports for non-numeric pid=${pid}`);
    return [];
  }
  const script = `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress`;
  const out = runPowerShell(script);
  return out ? parsePortsJson(out) : [];
}

function readEnvShortcut(): BridgeConnection | null {
  const envPort = process.env.ANTIGRAVITY_PORT;
  const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!envPort || !envCsrf) return null;
  const useTls = process.env.ANTIGRAVITY_TLS !== 'false';
  log.info(`using env config: port=${envPort}, tls=${useTls}`);
  return { port: Number(envPort), csrfToken: envCsrf, useTls };
}

async function probeBothTls(
  port: number,
  csrfToken: string,
  probeFn: (conn: BridgeConnection) => Promise<void>,
): Promise<BridgeConnection | null> {
  for (const useTls of [true, false] as const) {
    try {
      await probeFn({ port, csrfToken, useTls });
      return { port, csrfToken, useTls };
    } catch {
      /* try next */
    }
  }
  return null;
}

async function tryProcessConnection(
  proc: LSProcessInfo,
  listListenPorts: (pid: string) => number[],
  probeFn: (conn: BridgeConnection) => Promise<void>,
): Promise<BridgeConnection | null> {
  const csrfMatch = proc.cmd.match(/--csrf_token\s+(\S+)/);
  if (!csrfMatch) return null;
  const csrf = csrfMatch[1];
  const extPortMatch = proc.cmd.match(/--extension_server_port\s+(\d+)/);
  const extPort = extPortMatch ? Number(extPortMatch[1]) : 0;

  for (const port of listListenPorts(proc.pid)) {
    if (port === extPort) continue;
    const conn = await probeBothTls(port, csrf, probeFn);
    if (conn) return conn;
  }
  return null;
}

export async function discoverAntigravityLS(deps: DiscoveryDeps = {}): Promise<BridgeConnection> {
  const envHit = readEnvShortcut();
  if (envHit) return envHit;

  const platform = deps.platform ?? osPlatform();
  const isWin = platform === 'win32';
  const listProcesses = deps.listProcesses ?? (isWin ? listProcessesViaPowerShell : listProcessesViaPs);
  const listListenPorts = deps.listListenPorts ?? (isWin ? listListenPortsViaPowerShell : listListenPortsViaLsof);
  const probeFn = deps.probe ?? defaultProbe;

  const procs = listProcesses();
  if (procs.length === 0) {
    throw new Error(`No Antigravity Language Server process found (platform=${platform})`);
  }

  for (const proc of procs) {
    const conn = await tryProcessConnection(proc, listListenPorts, probeFn);
    if (conn) {
      log.info(`discovered LS: port=${conn.port}, tls=${conn.useTls}, pid=${proc.pid}, platform=${platform}`);
      return conn;
    }
  }
  throw new Error('Could not discover Antigravity Language Server ConnectRPC port');
}
