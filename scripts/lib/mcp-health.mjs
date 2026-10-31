import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, extname, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

// SYNC: This build-free helper intentionally duplicates the MCP health decision
// tree from packages/api/src/config/capabilities/capability-orchestrator.ts.
// Keep resolveRequiredMcpStatus() and the Pencil transport helpers in sync.

const PENCIL_DIR_PREFIX = 'highagency.pencildev-';
const PENCIL_BINARY_SUFFIX = 'out/mcp-server-darwin-arm64';
const PENCIL_EXTENSIONS_DIR = resolve(homedir(), '.antigravity/extensions');
const VSCODE_EXTENSIONS_DIR = resolve(homedir(), '.vscode/extensions');
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;
const SCHEME_LIKE_SPEC_RE = /^[A-Za-z][A-Za-z\d+.-]*:[^\\/]/;
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

function parsePencilVersion(dirName) {
  const withoutPrefix = dirName.slice(PENCIL_DIR_PREFIX.length);
  const match = withoutPrefix.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function comparePencilDirs(a, b) {
  const va = parsePencilVersion(a);
  const vb = parsePencilVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (va[index] !== vb[index]) return va[index] - vb[index];
  }
  return 0;
}

function inferPencilApp(command, envApp) {
  const explicit = envApp?.trim().toLowerCase();
  if (explicit === 'vscode') return 'vscode';
  if (explicit === 'antigravity') return 'antigravity';
  if (command.includes(`${sep}.vscode${sep}extensions${sep}`) || command.includes('/.vscode/extensions/')) {
    return 'vscode';
  }
  return 'antigravity';
}

async function findLatestPencilBinary(extensionsDir) {
  try {
    const entries = await readdir(extensionsDir);
    const pencilDirs = entries.filter((entry) => entry.startsWith(PENCIL_DIR_PREFIX)).sort(comparePencilDirs);
    if (pencilDirs.length === 0) return null;
    const latest = pencilDirs[pencilDirs.length - 1];
    return resolve(extensionsDir, latest, PENCIL_BINARY_SUFFIX);
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === 'string' ? value : '';
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

function resolveHomeDir(env) {
  return env?.HOME || env?.USERPROFILE || homedir();
}

function resolveLocalPath(baseDir, value, env) {
  const resolvedHome = resolveHomeDir(env);
  if (value === '~') return resolvedHome;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(resolvedHome, value.slice(2));
  }
  if (WINDOWS_DRIVE_PATH_RE.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    return value;
  }
  return resolve(baseDir, value);
}

function resolveCommandOnPath(command) {
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (pathEntries.length === 0) return null;

  const suffixes =
    process.platform === 'win32'
      ? extname(command)
        ? ['']
        : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .map((entry) => entry.trim())
            .filter(Boolean)
      : [''];

  for (const dir of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${command}${suffix}`);
      if (isExecutableCommandPath(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function commandExists(baseDir, command, env) {
  if (!command || typeof command !== 'string') return false;
  if (command.includes('/') || command.includes('\\') || command.startsWith('.') || command.startsWith('~')) {
    return isExecutableCommandPath(resolveLocalPath(baseDir, command, env));
  }
  return resolveCommandOnPath(command) !== null;
}

function extractArtifactCandidate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const equalIndex = trimmed.indexOf('=');
  if (trimmed.startsWith('--') && equalIndex > 2 && equalIndex < trimmed.length - 1) {
    return trimmed.slice(equalIndex + 1);
  }
  return trimmed;
}

function isLikelyPackageSpecifier(value) {
  return (
    value.startsWith('@') ||
    (SCHEME_LIKE_SPEC_RE.test(value) && !WINDOWS_DRIVE_PATH_RE.test(value) && !value.startsWith('~/'))
  );
}

function isLocalArtifactArg(value) {
  const candidate = extractArtifactCandidate(value);
  if (!candidate || candidate.startsWith('-')) return false;
  if (URL_SCHEME_RE.test(candidate)) return false;
  if (isLikelyPackageSpecifier(candidate)) return false;
  if (
    candidate.startsWith('.') ||
    candidate.startsWith('~') ||
    WINDOWS_DRIVE_PATH_RE.test(candidate) ||
    candidate.startsWith('/') ||
    candidate.startsWith('\\')
  ) {
    return true;
  }
  if (candidate.includes('/') || candidate.includes('\\')) return true;
  return LOCAL_ARTIFACT_EXTENSIONS.has(extname(candidate).toLowerCase());
}

function referencedArtifactExists(baseDir, args, env) {
  if (!Array.isArray(args)) return true;
  const artifactArgs = args.filter(isLocalArtifactArg).map(extractArtifactCandidate);
  if (artifactArgs.length === 0) return true;
  return artifactArgs.every((artifactArg) => artifactArg && existsSync(resolveLocalPath(baseDir, artifactArg, env)));
}

export function inspectManifestSkills(repoRoot) {
  const manifestPath = resolve(repoRoot, 'cat-cafe-skills', 'manifest.yaml');
  if (!existsSync(manifestPath)) {
    return {
      skills: {},
      error: `manifest not found: ${manifestPath}`,
    };
  }

  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const parsed = parseYaml(raw) ?? {};
    const skills = parsed.skills;
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
      return {
        skills: {},
        error: 'manifest.yaml missing top-level "skills" map',
      };
    }
    return { skills, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      skills: {},
      error: `failed to parse manifest.yaml: ${message}`,
    };
  }
}

export function loadManifestSkills(repoRoot) {
  return inspectManifestSkills(repoRoot).skills;
}

export function loadCapabilitiesConfig(repoRoot) {
  const capabilitiesPath = resolve(repoRoot, '.cat-cafe', 'capabilities.json');
  if (!existsSync(capabilitiesPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(capabilitiesPath, 'utf-8'));
    return parsed && Array.isArray(parsed.capabilities) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadResolvedMcpState(repoRoot) {
  const statePath = resolve(repoRoot, '.cat-cafe', 'mcp-resolved.json');
  if (!existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function hasUsableTransport(desc) {
  if (desc?.transport === 'streamableHttp') {
    return typeof desc?.url === 'string' && desc.url.trim().length > 0;
  }
  if (typeof desc?.resolver === 'string' && desc.resolver.trim().length > 0) {
    return true;
  }
  return typeof desc?.command === 'string' && desc.command.trim().length > 0;
}

export async function resolvePencilCommand(options = {}) {
  const env = options.env ?? process.env;
  const baseDir = options.repoRoot ?? process.cwd();
  const explicitCommand = env.PENCIL_MCP_BIN?.trim();
  if (explicitCommand) {
    const resolvedCommand = resolveLocalPath(baseDir, explicitCommand, env);
    if (!isExecutableCommandPath(resolvedCommand)) return null;
    return {
      command: resolvedCommand,
      args: ['--app', inferPencilApp(resolvedCommand, env.PENCIL_MCP_APP)],
    };
  }

  const antigravityBinary = await findLatestPencilBinary(options.antigravityDir ?? PENCIL_EXTENSIONS_DIR);
  if (antigravityBinary && isExecutableCommandPath(antigravityBinary)) {
    return { command: antigravityBinary, args: ['--app', 'antigravity'] };
  }

  const vscodeBinary = await findLatestPencilBinary(options.vscodeDir ?? VSCODE_EXTENSIONS_DIR);
  if (vscodeBinary && isExecutableCommandPath(vscodeBinary)) {
    return { command: vscodeBinary, args: ['--app', 'vscode'] };
  }

  return null;
}

export function collectSkillRequirements(skillsMap) {
  const result = new Map();
  for (const [skillName, entry] of Object.entries(skillsMap ?? {})) {
    const requiresMcp = asArray(entry?.requires_mcp)
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
    if (requiresMcp.length > 0) result.set(skillName, requiresMcp);
  }
  return result;
}

export async function resolveRequiredMcpStatus(repoRoot, mcpId, options = {}) {
  const capabilities = options.capabilities ?? loadCapabilitiesConfig(repoRoot);
  const capability = capabilities?.capabilities?.find((entry) => entry.id === mcpId && entry.type === 'mcp');
  if (!capability || capability.enabled === false || !capability.mcpServer) {
    return {
      id: mcpId,
      status: 'missing',
      reason:
        capability?.enabled === false
          ? 'declared but disabled in capabilities.json'
          : 'not declared in capabilities.json',
    };
  }

  if (capability.mcpServer.resolver === 'pencil') {
    const resolved = await resolvePencilCommand({ env: options.env, repoRoot });
    return resolved
      ? { id: mcpId, status: 'ready', reason: `resolved via ${resolved.args?.[1] ?? 'resolver'}` }
      : { id: mcpId, status: 'unresolved', reason: 'resolver declared but no local Pencil installation found' };
  }

  const command = asString(capability.mcpServer.command).trim();
  if (command && !commandExists(repoRoot, command, options.env)) {
    return {
      id: mcpId,
      status: 'unresolved',
      reason: `command not found: ${command}`,
    };
  }

  if (!referencedArtifactExists(repoRoot, capability.mcpServer.args, options.env)) {
    return {
      id: mcpId,
      status: 'unresolved',
      reason: 'command args reference missing local artifact',
    };
  }

  if (hasUsableTransport(capability.mcpServer)) {
    return {
      id: mcpId,
      status: 'ready',
      reason:
        capability.mcpServer.transport === 'streamableHttp'
          ? `remote ${asString(capability.mcpServer.url)}`
          : `stdio ${asString(capability.mcpServer.command)}`.trim(),
    };
  }

  return {
    id: mcpId,
    status: 'unresolved',
    reason: 'declared but missing usable command/url',
  };
}
