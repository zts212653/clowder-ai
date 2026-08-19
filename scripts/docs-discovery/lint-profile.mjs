#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadProfileEntries } from '@cat-cafe/shared/profile-frontmatter-parser';
import { parse as parseYaml } from 'yaml';
import { runScheduledDriftScan } from './lib/drift-scan.mjs';
import { resolveDocsProfileScope } from './lib/scope-resolver.mjs';

const MISSING_DESCRIPTION_PROVENANCE_CODES = new Set([
  'f243/missing-description-source',
  'f243/missing-description-author',
  'f243/missing-description-updated-at',
]);

const ALWAYS_HARD_FAIL_CODES_FOR_EXISTING = new Set(['f243/invalid-frontmatter']);

const PROFILE_CHANGE_HARD_FAIL_CODES_FOR_EXISTING = new Set([
  'f243/missing-frontmatter',
  'f243/missing-description',
  'f243/missing-description-source',
  'f243/missing-description-author',
  'f243/missing-description-updated-at',
  'f243/description-too-long',
  'f243/placeholder-description',
  'f243/description-multiline',
  'f243/invalid-description-source',
  'f243/invalid-description-updated-at',
  'f243/invalid-description-generated-at',
  'f243/imported-reserved-until-defined',
  'f243/model-provenance-missing',
]);

const DESCRIPTION_PROFILE_FIELDS = [
  'description',
  'description_source',
  'description_author',
  'description_updated_at',
  'description_generated_by',
  'description_generated_at',
  'description_confirmed_by',
];

export function lintProfileForRepo(repoRoot, options = {}) {
  const scope = resolveDocsProfileScope(repoRoot);
  const enforcedByRelativePath = new Map(scope.profile_enforced.map((entry) => [entry.relativePath, entry]));
  const base = options.base ?? 'origin/main';
  const changedFileList = options.changedFiles ?? discoverChangedFiles(repoRoot, base);
  const changedFiles = new Set(changedFileList);
  const newFiles = new Set(options.newFiles ?? (options.changedFiles ? [] : discoverNewFiles(repoRoot, base)));
  const derivedDriftChanges =
    options.changedFiles === undefined
      ? discoverDriftChanges(repoRoot, base, changedFileList, newFiles)
      : { h1ChangedFiles: [], frontmatterChangedFiles: [] };
  const h1ChangedFiles = new Set(options.h1ChangedFiles ?? derivedDriftChanges.h1ChangedFiles);
  const frontmatterChangedFiles = new Set(
    options.frontmatterChangedFiles ?? derivedDriftChanges.frontmatterChangedFiles,
  );
  const profileFieldChangedFiles = new Set(
    options.profileFieldChangedFiles ??
      (options.changedFiles === undefined
        ? discoverProfileFieldChanges(repoRoot, base, changedFileList, newFiles)
        : []),
  );

  const lintTargets = [...changedFiles].map((relativePath) => enforcedByRelativePath.get(relativePath)).filter(Boolean);

  const loaded = loadProfileEntries(lintTargets.map((entry) => entry.path));
  const errors = collectBlockingDiagnostics(
    repoRoot,
    loaded.entries,
    loaded.diagnostics,
    newFiles,
    profileFieldChangedFiles,
  );
  const warnings = collectChangeWarnings(enforcedByRelativePath, h1ChangedFiles, frontmatterChangedFiles);

  return { ok: errors.length === 0, errors, warnings };
}

function collectBlockingDiagnostics(repoRoot, entries, diagnostics, newFiles, profileFieldChangedFiles) {
  const errors = [];
  const entriesByRelativePath = new Map(entries.map((entry) => [toRelative(repoRoot, entry.path), entry]));
  for (const diagnostic of diagnostics) {
    const relativePath = toRelative(repoRoot, diagnostic.path);
    const isNew = newFiles.has(relativePath);
    const entry = entriesByRelativePath.get(relativePath);
    const addsDescriptionWithoutProvenance =
      profileFieldChangedFiles.has(relativePath) &&
      Boolean(entry?.description) &&
      MISSING_DESCRIPTION_PROVENANCE_CODES.has(diagnostic.code);
    const isProfileChangeDiagnostic =
      profileFieldChangedFiles.has(relativePath) && PROFILE_CHANGE_HARD_FAIL_CODES_FOR_EXISTING.has(diagnostic.code);
    if (
      isNew ||
      ALWAYS_HARD_FAIL_CODES_FOR_EXISTING.has(diagnostic.code) ||
      isProfileChangeDiagnostic ||
      addsDescriptionWithoutProvenance
    ) {
      errors.push(diagnostic);
    }
  }
  return errors;
}

function collectChangeWarnings(enforcedByRelativePath, h1ChangedFiles, frontmatterChangedFiles) {
  const warnings = [];
  for (const relativePath of h1ChangedFiles) {
    const target = enforcedByRelativePath.get(relativePath);
    if (target) {
      warnings.push({
        path: target.path,
        level: 'warn',
        code: 'f243/body-h1-changed',
        message: 'H1 changed; review whether description still matches the stable identity',
      });
    }
  }

  for (const relativePath of frontmatterChangedFiles) {
    const target = enforcedByRelativePath.get(relativePath);
    if (target) {
      warnings.push({
        path: target.path,
        level: 'warn',
        code: 'f243/frontmatter-key-changed',
        message: 'Discovery frontmatter changed; review whether description still matches the stable identity',
      });
    }
  }
  return warnings;
}

function discoverChangedFiles(repoRoot, base) {
  const output = runGitDiff(repoRoot, ['--name-only', `${base}...HEAD`], 'changed files');
  return output ? output.split('\n') : [];
}

function discoverNewFiles(repoRoot, base) {
  const output = runGitDiff(repoRoot, ['--name-status', '--diff-filter=ACR', `${base}...HEAD`], 'new files');
  return output ? output.split('\n').map(parseNewFilePathFromNameStatus).filter(Boolean) : [];
}

function discoverDriftChanges(repoRoot, base, changedFiles, newFiles) {
  const h1ChangedFiles = [];
  const frontmatterChangedFiles = [];
  for (const relativePath of changedFiles) {
    if (newFiles.has(relativePath)) continue;
    const previousContent = readFileAtRevision(repoRoot, base, relativePath);
    if (previousContent === null) continue;

    let currentContent = '';
    try {
      currentContent = readFileSync(path.join(repoRoot, relativePath), 'utf8');
    } catch {
      continue;
    }

    if (extractH1(previousContent) !== extractH1(currentContent)) {
      h1ChangedFiles.push(relativePath);
    }
    if (extractFrontmatterBlock(previousContent) !== extractFrontmatterBlock(currentContent)) {
      frontmatterChangedFiles.push(relativePath);
    }
  }
  return { h1ChangedFiles, frontmatterChangedFiles };
}

function discoverProfileFieldChanges(repoRoot, base, changedFiles, newFiles) {
  const profileFieldChangedFiles = [];
  for (const relativePath of changedFiles) {
    if (newFiles.has(relativePath)) continue;
    const previousContent = readFileAtRevision(repoRoot, base, relativePath);
    if (previousContent === null) continue;

    let currentContent = '';
    try {
      currentContent = readFileSync(path.join(repoRoot, relativePath), 'utf8');
    } catch {
      continue;
    }

    if (profileFieldSnapshot(previousContent) !== profileFieldSnapshot(currentContent)) {
      profileFieldChangedFiles.push(relativePath);
    }
  }
  return profileFieldChangedFiles;
}

function readFileAtRevision(repoRoot, revision, relativePath) {
  try {
    return execFileSync('git', ['show', `${revision}:${relativePath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function runGitDiff(repoRoot, args, label) {
  try {
    return execFileSync('git', ['diff', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : '';
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`Unable to discover ${label} from git diff${suffix}`);
  }
}

function parseNewFilePathFromNameStatus(line) {
  const parts = line.split('\t');
  const status = parts[0] ?? '';
  if (status === 'A') return parts[1] ?? null;
  if (status.startsWith('C') || status.startsWith('R')) return parts[2] ?? null;
  return null;
}

function extractH1(content) {
  const line = content.split(/\r?\n/).find((candidate) => /^#\s+/.test(candidate));
  return line ? line.replace(/^#\s+/, '').trim() : null;
}

function extractFrontmatterBlock(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? (match[1] ?? '').trim() : null;
}

function profileFieldSnapshot(content) {
  const frontmatterBlock = extractFrontmatterBlock(content);
  if (frontmatterBlock === null) return '{}';

  try {
    const parsed = parseYaml(frontmatterBlock);
    if (!isRecord(parsed)) return '{}';
    const snapshot = {};
    for (const field of DESCRIPTION_PROFILE_FIELDS) {
      if (Object.hasOwn(parsed, field)) {
        snapshot[field] = parsed[field];
      }
    }
    return JSON.stringify(sortObject(snapshot));
  } catch {
    return JSON.stringify({ __invalidFrontmatter: frontmatterBlock });
  }
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRelative(repoRoot, absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

function parseArgs(argv) {
  const options = { base: 'origin/main' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') {
      options.base = argv[index + 1] ?? options.base;
      index += 1;
    } else if (arg === '--repo-root') {
      options.repoRoot = argv[index + 1];
      index += 1;
    } else if (arg === '--drift-scan') {
      options.driftScan = true;
    } else if (arg === '--drift-threshold-months') {
      options.driftThresholdMonths = parsePositiveNumber(argv[index + 1], '--drift-threshold-months');
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parsePositiveNumber(value, optionName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return parsed;
}

function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot());
    if (options.driftScan) {
      const result = runScheduledDriftScan(repoRoot, { thresholdMonths: options.driftThresholdMonths });
      for (const warning of result.warnings) {
        console.warn(`[warn] ${warning.code} ${warning.relativePath}: ${warning.message}`);
      }
      console.log(`F243 drift scan passed with ${result.warnings.length} warning(s).`);
      process.exit(0);
    }
    const result = lintProfileForRepo(repoRoot, { base: options.base });
    for (const warning of result.warnings) {
      console.warn(`[warn] ${warning.code} ${toRelative(repoRoot, warning.path)}: ${warning.message}`);
    }
    for (const error of result.errors) {
      console.error(`[error] ${error.code} ${toRelative(repoRoot, error.path)}: ${error.message}`);
    }
    if (!result.ok) process.exit(1);
    console.log('F243 profile lint passed.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
