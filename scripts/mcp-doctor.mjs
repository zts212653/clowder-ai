#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const capabilitiesPath = path.join(repoRoot, '.cat-cafe', 'capabilities.json');
const resolvedPath = path.join(repoRoot, '.cat-cafe', 'mcp-resolved.json');
const manifestPath = path.join(repoRoot, 'cat-cafe-skills', 'manifest.yaml');
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;
const LOCAL_ARTIFACT_ROOT_SEGMENTS = new Set(['scripts', 'packages', 'tools', 'bin', 'dist', 'src']);
const LOCAL_ARTIFACT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.json',
  '.yaml',
  '.yml',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.cmd',
  '.bat',
]);

const CORE_SERVER_ARTIFACTS = new Map([
  ['cat-cafe', path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'index.js')],
  ['cat-cafe-collab', path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'collab.js')],
  ['cat-cafe-memory', path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'memory.js')],
  ['cat-cafe-signals', path.join(repoRoot, 'packages', 'mcp-server', 'dist', 'signals.js')],
]);

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function readManifestSkills() {
  if (!existsSync(manifestPath)) return {};
  const manifest = YAML.parse(readFileSync(manifestPath, 'utf8'));
  return manifest?.skills ?? {};
}

function buildRequiredBy(skills) {
  const requiredBy = new Map();
  for (const [skillName, meta] of Object.entries(skills)) {
    const requires = Array.isArray(meta?.requires_mcp) ? meta.requires_mcp : [];
    for (const id of requires.filter((item) => typeof item === 'string' && item.trim().length > 0)) {
      if (!requiredBy.has(id)) requiredBy.set(id, []);
      requiredBy.get(id).push(skillName);
    }
  }
  return requiredBy;
}

function commandExists(command) {
  if (!command || typeof command !== 'string') return false;
  if (command.includes('/') || command.includes('\\') || command.startsWith('.')) {
    const resolved = resolveLocalPath(command);
    return isExecutableCommandPath(resolved);
  }
  return resolveCommandOnPath(command) !== null;
}

function isExecutableCommandPath(filePath) {
  if (!existsSync(filePath)) return false;

  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return false;
    if (process.platform === 'win32') return true;
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function resolveCommandOnPath(command) {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);

  if (pathEntries.length === 0) return null;

  const suffixes =
    process.platform === 'win32'
      ? path.extname(command)
        ? ['']
        : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .map((entry) => entry.trim())
            .filter(Boolean)
      : [''];

  for (const dir of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${command}${suffix}`);
      if (isExecutableCommandPath(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function referencedArtifactExists(args) {
  if (!Array.isArray(args)) return true;
  const artifactArgs = args.filter(isLocalArtifactArg);
  if (artifactArgs.length === 0) return true;

  return artifactArgs.every((artifactArg) => existsSync(resolveArtifactPath(artifactArg)));
}

function extractFlagValue(arg) {
  if (!arg.startsWith('-')) return null;

  const separatorIndex = arg.indexOf('=');
  if (separatorIndex <= 1 || separatorIndex === arg.length - 1) {
    return null;
  }

  return arg.slice(separatorIndex + 1).trim();
}

function isLocalArtifactArg(value) {
  if (typeof value !== 'string') return false;

  const rawArg = value.trim();
  if (!rawArg) return false;

  const artifactArg = extractFlagValue(rawArg) ?? rawArg;
  if (artifactArg.startsWith('-')) return false;
  if (URL_SCHEME_RE.test(artifactArg)) return false;
  if (artifactArg.startsWith('@') && !artifactArg.startsWith('@/') && !artifactArg.startsWith('@\\')) {
    return false;
  }

  if (
    artifactArg.startsWith('.') ||
    artifactArg.startsWith('~') ||
    path.isAbsolute(artifactArg) ||
    WINDOWS_DRIVE_PATH_RE.test(artifactArg)
  ) {
    return true;
  }

  if (artifactArg.includes('/') || artifactArg.includes('\\')) {
    if (artifactArg.includes(':')) return false;
    if (LOCAL_ARTIFACT_EXTENSIONS.has(path.extname(artifactArg).toLowerCase())) {
      return true;
    }

    const [firstSegment] = artifactArg.split(/[\\/]/);
    return LOCAL_ARTIFACT_ROOT_SEGMENTS.has(firstSegment);
  }

  return LOCAL_ARTIFACT_EXTENSIONS.has(path.extname(artifactArg).toLowerCase());
}

function resolveArtifactPath(artifactArg) {
  const rawArg = artifactArg.trim();
  return resolveLocalPath(extractFlagValue(rawArg) ?? rawArg);
}

function resolveLocalPath(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2));
  }
  if (path.isAbsolute(value) || WINDOWS_DRIVE_PATH_RE.test(value)) {
    return value;
  }
  return path.resolve(repoRoot, value);
}

function normalizePencilApp(raw) {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (value === 'antigravity') return 'antigravity';
  if (['vscode', 'cursor', 'vscode-insiders', 'visual_studio_code'].includes(value)) return 'vscode';
  return undefined;
}

function inferPencilApp(command, envApp) {
  return (
    normalizePencilApp(envApp) ??
    (command.includes(`${path.sep}.vscode${path.sep}`) || command.includes(`${path.sep}.cursor${path.sep}`)
      ? 'vscode'
      : 'antigravity')
  );
}

function findLatestPencilBinary() {
  const explicit = process.env.PENCIL_MCP_BIN?.trim();
  if (explicit) {
    const resolvedExplicit = resolveLocalPath(explicit);
    if (isExecutableCommandPath(resolvedExplicit)) {
      return { command: resolvedExplicit, app: inferPencilApp(resolvedExplicit, process.env.PENCIL_MCP_APP) };
    }
    return { invalidExplicit: explicit };
  }

  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'darwin';
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  const binarySuffix = `out/mcp-server-${osName}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
  const scanDirs = [
    { app: 'antigravity', dir: path.join(homedir(), '.antigravity', 'extensions') },
    { app: 'vscode', dir: path.join(homedir(), '.vscode', 'extensions') },
    { app: 'vscode', dir: path.join(homedir(), '.cursor', 'extensions') },
    { app: 'vscode', dir: path.join(homedir(), '.vscode-insiders', 'extensions') },
  ];

  const preferredApp = normalizePencilApp(process.env.PENCIL_MCP_APP);
  const candidates = [];

  for (const { app, dir } of scanDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith('highagency.pencildev-')) continue;
      const binaryPath = path.join(dir, entry, binarySuffix);
      if (isExecutableCommandPath(binaryPath)) candidates.push({ command: binaryPath, app, version: entry });
    }
  }

  const filtered = preferredApp ? candidates.filter((candidate) => candidate.app === preferredApp) : candidates;
  const ordered = (filtered.length > 0 ? filtered : candidates).sort((a, b) =>
    a.version.localeCompare(b.version, undefined, { numeric: true }),
  );
  const latest = ordered.at(-1);
  return latest ? { command: latest.command, app: latest.app } : null;
}

function statusForCapability(id, capability) {
  const builtInArtifact = CORE_SERVER_ARTIFACTS.get(id);
  if (!capability || capability.enabled === false || !capability.mcpServer) {
    const reasonBase =
      capability?.enabled === false
        ? 'declared but disabled in capabilities.json'
        : 'not declared in capabilities.json';
    if (builtInArtifact && existsSync(builtInArtifact)) {
      return { id, status: 'missing', reason: `${reasonBase}; build artifact is present` };
    }
    return { id, status: 'missing', reason: reasonBase };
  }

  if (builtInArtifact) {
    return existsSync(builtInArtifact)
      ? { id, status: 'ready', reason: `built from ${path.relative(repoRoot, builtInArtifact)}` }
      : {
          id,
          status: 'unresolved',
          reason: `expected build artifact missing: ${path.relative(repoRoot, builtInArtifact)}`,
        };
  }

  const server = capability.mcpServer;
  if (server.resolver === 'pencil') {
    const resolved = findLatestPencilBinary();
    if (resolved?.invalidExplicit) {
      return {
        id,
        status: 'unresolved',
        reason: `configured PENCIL_MCP_BIN is not executable: ${resolved.invalidExplicit}`,
      };
    }
    return resolved
      ? { id, status: 'ready', reason: `resolved via ${resolved.app}` }
      : { id, status: 'unresolved', reason: 'resolver declared but no local Pencil installation found' };
  }

  if (server.transport === 'streamableHttp') {
    return server.url?.trim()
      ? { id, status: 'ready', reason: `remote ${server.url.trim()}` }
      : { id, status: 'unresolved', reason: 'streamableHttp transport is missing url' };
  }

  if (!server.command?.trim()) {
    return { id, status: 'unresolved', reason: 'declared but missing command' };
  }

  if (!commandExists(server.command.trim())) {
    return { id, status: 'unresolved', reason: `command not found: ${server.command.trim()}` };
  }

  if (!referencedArtifactExists(server.args)) {
    return { id, status: 'unresolved', reason: 'command args reference missing local artifact' };
  }

  return { id, status: 'ready', reason: `stdio ${server.command.trim()}` };
}

const capabilities = readJson(capabilitiesPath);
const requiredBy = buildRequiredBy(readManifestSkills());
const capabilityMap = new Map(
  (capabilities?.capabilities ?? [])
    .filter((entry) => entry?.type === 'mcp' && typeof entry.id === 'string')
    .map((entry) => [entry.id, entry]),
);

const ids = new Set([...CORE_SERVER_ARTIFACTS.keys(), ...requiredBy.keys(), ...capabilityMap.keys()]);
const statuses = [...ids]
  .sort((a, b) => a.localeCompare(b))
  .map((id) => ({
    ...statusForCapability(id, capabilityMap.get(id)),
    requiredBy: requiredBy.get(id) ?? [],
  }));

const counts = statuses.reduce(
  (acc, item) => {
    acc[item.status] += 1;
    return acc;
  },
  { ready: 0, missing: 0, unresolved: 0 },
);

console.log('MCP Doctor');
console.log('==========');
console.log(`capabilities.json: ${existsSync(capabilitiesPath) ? 'present' : 'missing'}`);
console.log(`mcp-resolved.json: ${existsSync(resolvedPath) ? 'present' : 'missing'}`);
console.log(`ready=${counts.ready} missing=${counts.missing} unresolved=${counts.unresolved}`);
console.log('');

for (const item of statuses) {
  const dependents = item.requiredBy.length > 0 ? ` | required by: ${item.requiredBy.join(', ')}` : '';
  console.log(`[${item.status}] ${item.id} — ${item.reason}${dependents}`);
}

process.exit(counts.missing === 0 && counts.unresolved === 0 ? 0 : 1);
