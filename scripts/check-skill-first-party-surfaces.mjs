#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const DEFAULT_ALLOWLIST_PATH = 'scripts/check-skill-first-party-surfaces.allowlist.json';

const FIRST_PARTY_ACTION_ROUTES = [/\/api\/workspace\/navigate\b/, /\/api\/preview\/auto-open\b/, /\/api\/callbacks\//];

const FIRST_PARTY_HOST_HINTS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?/i,
  /(?:^|[\s"'`(])(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d+)?(?:\/|\s|$)/i,
  /\b(?:API_SERVER_PORT|API_PORT|CAT_CAFE_API_URL|NEXT_PUBLIC_API_URL)\b/,
  /\$\{?(?:API_SERVER_PORT|API_PORT|CAT_CAFE_API_URL|NEXT_PUBLIC_API_URL)\}?/,
];

const NEGATIVE_GUIDANCE_PATTERNS = [
  /\bdo\s+not\b/i,
  /\bdon't\b/i,
  /\bnot\s+use\b/i,
  /\bavoid\b/i,
  /不要/,
  /禁止/,
  /不再要求/,
  /不要手写/,
  /不要把.*当主路径/,
  /主路径.*不是/,
  /\binstead\s+of\s+(?:raw\s+)?(?:curl|localhost|first-party\s+(?:api|http)|callback\s+http)\b/i,
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isMarkdownTarget(relPath) {
  if (relPath.startsWith('cat-cafe-skills/refs/') && relPath.endsWith('.md')) return true;
  return /(^|\/)SKILL\.md$/.test(relPath) && relPath.startsWith('cat-cafe-skills/');
}

function walkMarkdownTargets(rootDir, baseDir = rootDir) {
  const targets = [];
  if (!existsSync(rootDir)) return targets;

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      targets.push(...walkMarkdownTargets(fullPath, baseDir));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const relPath = relative(baseDir, fullPath).replaceAll('\\', '/');
    if (isMarkdownTarget(relPath)) targets.push(fullPath);
  }

  return targets;
}

function collectSkillSurfaceTargets(repoRoot) {
  return walkMarkdownTargets(join(repoRoot, 'cat-cafe-skills'), repoRoot).sort();
}

function validateAllowlistEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`allowlist entry #${index + 1} must be an object`);
  }
  for (const field of ['path', 'pattern', 'reason']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      throw new Error(`allowlist entry #${index + 1} missing non-empty ${field}`);
    }
  }
  return {
    path: entry.path.replaceAll('\\', '/'),
    pattern: entry.pattern,
    reason: entry.reason,
  };
}

function loadAllowlist(repoRoot, allowlistPath = DEFAULT_ALLOWLIST_PATH) {
  const fullPath = resolve(repoRoot, allowlistPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Skill surface allowlist missing: ${relative(repoRoot, fullPath)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fullPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Skill surface allowlist is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed.allow)) {
    throw new Error('Skill surface allowlist must contain an "allow" array');
  }

  return asArray(parsed.allow).map((entry, index) => validateAllowlistEntry(entry, index));
}

function hasFirstPartyActionRoute(text) {
  return FIRST_PARTY_ACTION_ROUTES.some((pattern) => pattern.test(text));
}

function hasFirstPartyHostHint(text) {
  return FIRST_PARTY_HOST_HINTS.some((pattern) => pattern.test(text));
}

function isNegativeGuidance(text) {
  return NEGATIVE_GUIDANCE_PATTERNS.some((pattern) => pattern.test(text));
}

function isAllowedByEntry(relPath, chunk, allowlist) {
  return allowlist.some((entry) => entry.path === relPath && chunk.includes(entry.pattern));
}

function scanSkillSurfaceText(content, relPath, allowlist = []) {
  const hits = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!/\bcurl\b/i.test(line)) continue;

    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length, index + 8);
    const chunk = lines.slice(start, end).join('\n');

    if (!hasFirstPartyActionRoute(chunk)) continue;
    if (!hasFirstPartyHostHint(chunk)) continue;
    if (isNegativeGuidance(chunk)) continue;
    if (isAllowedByEntry(relPath, chunk, allowlist)) continue;

    hits.push({
      line: index + 1,
      path: relPath,
      text: line.trim(),
    });
  }

  return hits;
}

function scanRepo(repoRoot, allowlist = loadAllowlist(repoRoot)) {
  const hits = [];
  for (const filePath of collectSkillSurfaceTargets(repoRoot)) {
    const relPath = relative(repoRoot, filePath).replaceAll('\\', '/');
    const content = readFileSync(filePath, 'utf-8');
    hits.push(...scanSkillSurfaceText(content, relPath, allowlist));
  }
  return hits;
}

function main() {
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : defaultRepoRoot;
  let hits;
  try {
    hits = scanRepo(repoRoot);
  } catch (error) {
    console.error(`❌ Skill first-party surface check failed closed: ${error.message}`);
    process.exit(1);
  }

  if (hits.length === 0) {
    console.log('✓ No raw first-party Hub/API curl main paths found in skill guidance.');
    return;
  }

  console.error('❌ Raw first-party Hub/API curl examples found in skill guidance.');
  console.error('Use typed MCP/helper surfaces instead, or add a reviewed allowlist entry with reason.');
  console.error('');
  for (const hit of hits) {
    console.error(`  ${hit.path}:${hit.line}: ${hit.text}`);
  }
  process.exit(1);
}

const isEntryPoint = process.argv[1] && new URL(process.argv[1], 'file://').href === import.meta.url;
if (isEntryPoint) {
  main();
}

export { collectSkillSurfaceTargets, loadAllowlist, scanRepo, scanSkillSurfaceText };
