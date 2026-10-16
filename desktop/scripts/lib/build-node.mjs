import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function nodeInfo() {
  return { version: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch };
}

function versionParts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Invalid stable Node version: ${version}`);
  return match.slice(1).map(Number);
}

// engines.node currently declares a comparator range. Reject unknown syntax
// rather than silently treating an unparsed future constraint as compatible.
export function satisfiesEngine(version, range) {
  const actual = versionParts(version);
  if (typeof range !== 'string' || !range.trim()) throw new Error('Missing engines.node');
  return range
    .trim()
    .split(/\s+/)
    .map((token) => {
      const match = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/.exec(token);
      if (!match) throw new Error(`Unsupported engines.node range: ${range}`);
      const wanted = match.slice(2).map(Number);
      const index = actual.findIndex((part, i) => part !== wanted[i]);
      const diff = index < 0 ? 0 : actual[index] - wanted[index];
      switch (match[1] || '=') {
        case '>=':
          return diff >= 0;
        case '<=':
          return diff <= 0;
        case '>':
          return diff > 0;
        case '<':
          return diff < 0;
        default:
          return diff === 0;
      }
    })
    .every(Boolean);
}

export function validateNode(info, { engine, platform, arch, builtWith }) {
  if (!satisfiesEngine(info.version, engine))
    throw new Error(`Node ${info.version} does not satisfy engines.node ${engine}`);
  if (info.platform !== platform || info.arch !== arch) {
    throw new Error(`Node target ${info.platform}/${info.arch} does not match ${platform}/${arch}`);
  }
  if (!/^\d+$/.test(info.abi)) throw new Error(`Invalid Node ABI: ${info.abi}`);
  if (builtWith && (info.version !== builtWith.version || info.abi !== builtWith.abi)) {
    throw new Error(
      `Bundled Node ${info.version}/ABI ${info.abi} differs from build ${builtWith.version}/ABI ${builtWith.abi}`,
    );
  }
  return info;
}

export function engineAt(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines?.node;
}

function probeEnv(executable) {
  // Do not inherit NODE_OPTIONS/NODE_PATH, loader search overrides, compile
  // caches or host PATH. Keep only OS variables required for child creation.
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    const existing = Object.keys(process.env).find((name) => name.toLowerCase() === key.toLowerCase());
    if (existing) env[key] = process.env[existing];
  }
  const systemPath = process.platform === 'win32' ? path.join(env.SystemRoot, 'System32') : '/usr/bin:/bin';
  env.PATH = path.dirname(path.resolve(executable)) + path.delimiter + systemPath;
  return env;
}

export function probeNode(executable, timeout = 15000) {
  return JSON.parse(
    execFileSync(
      executable,
      [
        '-p',
        'JSON.stringify({version:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch})',
      ],
      { encoding: 'utf8', timeout, env: probeEnv(executable) },
    ),
  );
}

// Run against deployed/installed files with the bundled executable. In-memory
// SQLite only; no Redis, user profile, persistent DB or running service access.
export function smokeNativeModules(executable, apiDir, timeout = 30000) {
  const api = fs.realpathSync(apiDir);
  const guard = path.join(import.meta.dirname, 'native-artifact-guard.cjs');
  const script = fs.readFileSync(path.join(import.meta.dirname, 'native-artifact-smoke.cjs'), 'utf8');
  return execFileSync(path.resolve(executable), ['--require', guard, '-e', script, api], {
    encoding: 'utf8',
    timeout,
    cwd: api,
    env: { ...probeEnv(executable), CLOWDER_NATIVE_SMOKE_ROOT: api },
  });
}
