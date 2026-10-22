import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, posix, resolve } from 'node:path';
import { parseVars } from '../lib/env-registry-parser.mjs';
import { loadEnvRegistrySource } from '../lib/env-registry-source.mjs';

export const ROOT = resolve(process.cwd());

export const isHomeRepo = existsSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'));

export const hasEnvExampleOpensource = existsSync(resolve(ROOT, '.env.example.opensource'));

export function readEnvFile(relPath) {
  const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    vars[key] = val;
  }
  return vars;
}

export function readEnvTemplateKeys(relPath) {
  const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
  const keys = new Set();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const activeMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (activeMatch) {
      keys.add(activeMatch[1]);
      continue;
    }

    const commentedMatch = trimmed.match(/^#\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (commentedMatch) {
      keys.add(commentedMatch[1]);
    }
  }

  return keys;
}

export function loadExampleRecommendedRegistryNames() {
  const src = loadEnvRegistrySource(resolve(ROOT, 'packages/api/src/config/env-registry.ts'));
  return new Set(
    parseVars(src)
      .filter((entry) => entry.exampleRecommended)
      .map((entry) => entry.name),
  );
}

export function readPowerShellFallback(relPath, pattern) {
  const content = readFileSync(resolve(ROOT, relPath), 'utf-8');
  const m = content.match(pattern);
  return m ? m[1] : null;
}

export function normalizeYamlListItem(line) {
  return line
    .replace(/\s+#.*$/, '')
    .replaceAll('"', '')
    .trim();
}

export function readYamlTopLevelKey(line) {
  return line.match(/^([A-Za-z0-9_-]+):\s*$/)?.[1] ?? null;
}

export function parseYamlTopLevelList(content, sectionName) {
  const lines = content.split('\n');
  const values = [];
  let inSection = false;

  for (const line of lines) {
    const topLevelKey = readYamlTopLevelKey(line);
    if (topLevelKey === sectionName) {
      inSection = true;
      continue;
    }
    if (topLevelKey && inSection) {
      break;
    }

    if (!inSection) continue;

    const listItem = line.match(/^ {2}- (.+)$/)?.[1];
    if (listItem) {
      const normalized = normalizeYamlListItem(listItem);
      if (normalized.length > 0) {
        values.push(normalized);
      }
    }
  }

  return values;
}

export function readYamlTopLevelList(relPath, sectionName) {
  return parseYamlTopLevelList(readFileSync(resolve(ROOT, relPath), 'utf-8'), sectionName);
}

export function readJsonFile(relPath) {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), 'utf-8'));
}

export function extractScriptRefs(command, packageRoot = '') {
  const refs = new Set();
  const matches = String(command).matchAll(
    /(?:^|\s)(?:bash|node)\s+['"]?((?:\.{1,2}\/|scripts\/)[^\s'"]+)|(?:^|\s)['"]?((?:\.{1,2}\/)*scripts\/[^\s'"]+)/g,
  );
  for (const match of matches) {
    const ref = match[1] ?? match[2];
    if (ref) refs.add(posix.join(packageRoot, ref));
  }
  return [...refs];
}

export function isManagedPath(relPath, managedRoots, managedFiles, managedScripts) {
  if (managedFiles.has(relPath) || managedScripts.has(relPath)) return true;
  for (const root of managedRoots) {
    if (relPath === root || relPath.startsWith(`${root}/`)) return true;
  }
  return false;
}

export function loadWorkspacePackageRootsByName() {
  const packagesDir = resolve(ROOT, 'packages');
  const rootsByName = new Map();

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = `packages/${entry.name}`;
    const packageJsonPath = resolve(ROOT, packageRoot, 'package.json');
    if (!existsSync(packageJsonPath)) continue;

    const packageJson = readJsonFile(`${packageRoot}/package.json`);
    if (typeof packageJson.name === 'string') {
      rootsByName.set(packageJson.name, packageRoot);
    }
  }

  return rootsByName;
}

export function parseYamlTransformTargets(content) {
  const lines = content.split('\n');
  const targets = [];
  let inSection = false;

  for (const line of lines) {
    const topLevelKey = readYamlTopLevelKey(line);
    if (topLevelKey === 'transforms') {
      inSection = true;
      continue;
    }
    if (topLevelKey && inSection) {
      break;
    }

    if (!inSection) continue;

    const target = line.match(/^ {2}- target:\s*(.+)$/)?.[1];
    if (target) {
      targets.push(normalizeYamlListItem(target));
    }
  }

  return targets;
}

export function readYamlTransformTargets(relPath) {
  return parseYamlTransformTargets(readFileSync(resolve(ROOT, relPath), 'utf-8'));
}

export function sanitizeFixture(relPath, content) {
  const tempRoot = mkdtempSync(resolve(tmpdir(), 'cat-cafe-sanitize-'));
  const fixturePath = resolve(tempRoot, relPath);
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, content);

  try {
    execFileSync('perl', ['-pi', resolve(ROOT, 'scripts/_sanitize-rules.pl'), fixturePath], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Declared the way the sync script declares it, so path-anchored rules resolve against a
      // real export root instead of an undeclared one.
      env: { ...process.env, CAT_CAFE_SANITIZE_ROOT: tempRoot },
    });
    return readFileSync(fixturePath, 'utf-8');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function assertPortableClaudeHookTemplate(template) {
  assert.doesNotMatch(template, /(?:\/(?:Users|home)\/[^"'\s]+|[A-Za-z]:(?:\/|\\\\+)Users(?:\/|\\\\+)[^"'\s]+)/);
}

export function readClaudeHookTemplateCommands(template) {
  const parsed = JSON.parse(template);
  return [parsed.hooks.SessionStart[0].hooks[0].command, parsed.hooks.Stop[0].hooks[0].command];
}

export function readSyncScript() {
  return readFileSync(resolve(ROOT, 'scripts/sync-to-opensource.sh'), 'utf-8');
}

export function readSanitizedTextExtensions() {
  const match = readSyncScript().match(/^SANITIZED_TEXT_EXTENSIONS=\(([^)]*)\)/m);
  assert.ok(match, 'sync-to-opensource.sh must declare SANITIZED_TEXT_EXTENSIONS');
  return match[1].trim().split(/\s+/).filter(Boolean);
}

export function readFunctionBody(content, functionName) {
  const start = content.indexOf(`${functionName}() {`);
  assert.notEqual(start, -1, `expected to find function ${functionName} in sync-to-opensource.sh`);

  const end = content.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `expected to find the end of function ${functionName} in sync-to-opensource.sh`);

  return content.slice(start, end);
}

export const expectedApiPort = isHomeRepo ? '3002' : '3004';

export const expectedFrontendPort = isHomeRepo ? '3001' : '3003';

export const repoLabel = isHomeRepo ? 'home' : 'open-source';
