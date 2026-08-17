#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');

export const SHARED_SKILL_REFS_ALIAS = '.cat-cafe-shared-refs';

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function normalizeReferenceTarget(rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/g, '').split('#', 1)[0];
  if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  if (target.startsWith('/') || /[{}*]/.test(target)) return null;
  return target.replaceAll('\\', '/');
}

export function extractFileReferences(content) {
  const refs = [];
  const seen = new Set();
  const patterns = [
    { kind: 'markdown-link', regex: /\]\(([^)]+\.md(?:#[^)\s]+)?)\)/g },
    { kind: 'inline-code', regex: /`([^`\n]+\.md(?:#[^`\n]+)?)`/g },
  ];

  for (const { kind, regex } of patterns) {
    for (const match of content.matchAll(regex)) {
      const target = normalizeReferenceTarget(match[1]);
      if (!target) continue;
      const key = `${match.index}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ kind, line: lineNumberAt(content, match.index ?? 0), target });
    }
  }
  return refs;
}

function sharedRefCandidate(skillDir, sharedRefsRoot, target) {
  const stablePrefix = `../${SHARED_SKILL_REFS_ALIAS}/`;
  if (target.startsWith(stablePrefix)) {
    return { relativeRef: target.slice(stablePrefix.length), stable: true };
  }

  const legacyPrefixes = ['../refs/', 'cat-cafe-skills/refs/'];
  for (const prefix of legacyPrefixes) {
    if (target.startsWith(prefix)) {
      return { relativeRef: target.slice(prefix.length), stable: false };
    }
  }

  if (target.startsWith('refs/')) {
    if (existsSync(resolve(skillDir, target))) return null;
    return { relativeRef: target.slice('refs/'.length), stable: false };
  }

  if (!target.includes('/') && existsSync(join(sharedRefsRoot, target))) {
    return { relativeRef: target, stable: false };
  }

  return null;
}

function aliasFinding(repoRoot, skillsRoot, sharedRefsRoot) {
  const aliasPath = join(skillsRoot, SHARED_SKILL_REFS_ALIAS);
  try {
    const stat = lstatSync(aliasPath);
    if (!stat.isSymbolicLink()) {
      return {
        code: 'invalid-canonical-alias',
        path: relative(repoRoot, aliasPath),
        line: 1,
        target: SHARED_SKILL_REFS_ALIAS,
        message: 'canonical shared refs coordinate must be a symlink',
      };
    }
    if (realpathSync(aliasPath) !== realpathSync(sharedRefsRoot)) {
      return {
        code: 'invalid-canonical-alias',
        path: relative(repoRoot, aliasPath),
        line: 1,
        target: SHARED_SKILL_REFS_ALIAS,
        message: 'canonical shared refs coordinate does not resolve to cat-cafe-skills/refs',
      };
    }
  } catch {
    return {
      code: 'missing-canonical-alias',
      path: relative(repoRoot, aliasPath),
      line: 1,
      target: SHARED_SKILL_REFS_ALIAS,
      message: 'canonical shared refs coordinate is missing',
    };
  }
  return null;
}

function scanSkillFile(repoRoot, skillFile, sharedRefsRoot) {
  const findings = [];
  let sharedReferenceCount = 0;
  const skillDir = dirname(skillFile);
  const content = readFileSync(skillFile, 'utf8');
  for (const ref of extractFileReferences(content)) {
    const candidate = sharedRefCandidate(skillDir, sharedRefsRoot, ref.target);
    if (!candidate) continue;
    sharedReferenceCount += 1;
    const sourcePath = relative(repoRoot, skillFile).replaceAll('\\', '/');
    const expected = join(sharedRefsRoot, candidate.relativeRef);
    if (!existsSync(expected)) {
      findings.push({
        code: 'missing-shared-reference',
        path: sourcePath,
        line: ref.line,
        target: ref.target,
        message: `shared reference target is missing: cat-cafe-skills/refs/${candidate.relativeRef}`,
      });
    } else if (!candidate.stable) {
      findings.push({
        code: 'unstable-shared-reference',
        path: sourcePath,
        line: ref.line,
        target: ref.target,
        message: `use ../${SHARED_SKILL_REFS_ALIAS}/${candidate.relativeRef}`,
      });
    }
  }
  return { findings, sharedReferenceCount };
}

export function scanSkillReferenceGraph(repoRoot) {
  const skillsRoot = join(repoRoot, 'cat-cafe-skills');
  const sharedRefsRoot = join(skillsRoot, 'refs');
  const findings = [];
  let sharedReferenceCount = 0;

  const aliasIssue = aliasFinding(repoRoot, skillsRoot, sharedRefsRoot);
  if (aliasIssue) findings.push(aliasIssue);

  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsRoot, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const result = scanSkillFile(repoRoot, skillFile, sharedRefsRoot);
    findings.push(...result.findings);
    sharedReferenceCount += result.sharedReferenceCount;
  }

  return { findings, sharedReferenceCount };
}

function main() {
  const repoRoot = process.argv[2] ? resolve(process.argv[2]) : defaultRepoRoot;
  let result;
  try {
    result = scanSkillReferenceGraph(repoRoot);
  } catch (error) {
    console.error(`FAIL skill reference integrity: ${error.message}`);
    process.exit(1);
  }

  if (result.findings.length === 0) {
    console.log(`PASS skill reference integrity: ${result.sharedReferenceCount} shared ref declarations resolved`);
    return;
  }

  console.error(`FAIL skill reference integrity: ${result.findings.length} finding(s)`);
  for (const finding of result.findings) {
    console.error(`  ${finding.path}:${finding.line} [${finding.code}] ${finding.target} — ${finding.message}`);
  }
  process.exit(1);
}

const isEntryPoint = process.argv[1] && new URL(process.argv[1], 'file://').href === import.meta.url;
if (isEntryPoint) main();
