#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadProfileEntries } from '@cat-cafe/shared/profile-frontmatter-parser';
import { resolveDocsProfileScope } from './lib/scope-resolver.mjs';

const GENERATOR_VERSION = 'f243-index-v1';
const PROFILE_CONTRACT_VERSION = 'f243-profile-v1';
const HAND_AUTHORED_INDEX_PATHS = new Set(['docs/taste/index.md']);

export function listManagedIndexPathsForRepo(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const now = options.now ?? new Date().toISOString();
  const scope = resolveDocsProfileScope(root, { resolvedAt: now });
  const loaded = loadProfileEntries(scope.profile_enforced.map((entry) => entry.path));
  const byRelativePath = new Map(scope.profile_enforced.map((entry) => [entry.relativePath, entry]));
  const models = buildDirectoryModels(root, loaded.entries, byRelativePath);
  const managedModels = models.filter((model) => !HAND_AUTHORED_INDEX_PATHS.has(model.outputPath));
  const modelsByOutputPath = new Map(managedModels.map((model) => [model.outputPath, model]));
  const orphanPaths = discoverOrphanGeneratedIndexPaths(root, scope, modelsByOutputPath);
  return [...new Set([...managedModels.map((model) => model.outputPath), ...orphanPaths])].sort();
}

export function isManagedGeneratedIndexContent(content) {
  return isGeneratedIndex(content);
}

export function generateIndexesForRepo(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const mode = options.mode ?? 'check';
  const now = options.now ?? new Date().toISOString();
  const scope = resolveDocsProfileScope(root, { resolvedAt: now });
  const loaded = loadProfileEntries(scope.profile_enforced.map((entry) => entry.path));
  const byRelativePath = new Map(scope.profile_enforced.map((entry) => [entry.relativePath, entry]));
  const models = buildDirectoryModels(root, loaded.entries, byRelativePath);
  const modelsByOutputPath = new Map(models.map((model) => [model.outputPath, model]));
  const changedPaths = [];
  const errors = [];
  const skippedPaths = [];

  for (const model of models) {
    if (HAND_AUTHORED_INDEX_PATHS.has(model.outputPath)) {
      skippedPaths.push(model.outputPath);
      continue;
    }
    collectDirectoryModelResult(root, model, { mode, now }, { changedPaths, errors, skippedPaths });
  }

  for (const outputPath of discoverOrphanGeneratedIndexPaths(root, scope, modelsByOutputPath)) {
    collectOrphanIndexResult(root, outputPath, mode, { changedPaths, errors });
  }

  return { ok: errors.length === 0, changedPaths, errors, skippedPaths };
}

function collectDirectoryModelResult(repoRoot, model, options, result) {
  const outputPath = path.join(repoRoot, model.outputPath);
  const existing = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null;
  if (existing !== null && !isGeneratedIndex(existing)) {
    result.changedPaths.push(model.outputPath);
    result.errors.push(`${model.outputPath} lost generated index marker`);
    return;
  }

  const existingGeneratedAt = existing ? readGeneratedAt(existing) : null;
  const rendered = renderIndexMarkdown(model, { generatedAt: existingGeneratedAt ?? options.now });
  const equivalent = existing !== null && stripGeneratedAt(existing) === stripGeneratedAt(rendered);
  if (equivalent) return;

  result.changedPaths.push(model.outputPath);
  if (options.mode === 'write') {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, renderIndexMarkdown(model, { generatedAt: options.now }), 'utf8');
  } else {
    result.errors.push(`${model.outputPath} is out of date`);
  }
}

function collectOrphanIndexResult(repoRoot, outputPath, mode, result) {
  result.changedPaths.push(outputPath);
  if (mode === 'write') {
    unlinkSync(path.join(repoRoot, outputPath));
  } else {
    result.errors.push(`${outputPath} is orphaned`);
  }
}

function discoverOrphanGeneratedIndexPaths(repoRoot, scope, modelsByOutputPath) {
  const candidates = new Set(
    scope.profile_exempt.filter((entry) => entry.reason === 'generated_artifact').map((entry) => entry.relativePath),
  );
  candidates.add('cat-cafe-skills/index.md');

  return [...candidates]
    .filter((relativePath) => !modelsByOutputPath.has(relativePath))
    .filter((relativePath) => !HAND_AUTHORED_INDEX_PATHS.has(relativePath))
    .filter((relativePath) => {
      const absolutePath = path.join(repoRoot, relativePath);
      return existsSync(absolutePath) && isGeneratedIndex(readFileSync(absolutePath, 'utf8'));
    })
    .sort();
}

function buildDirectoryModels(repoRoot, entries, scopeEntriesByRelativePath) {
  const groups = new Map();
  for (const entry of entries) {
    const scopeEntry = scopeEntriesByRelativePath.get(toRelative(repoRoot, entry.path));
    if (!scopeEntry) continue;
    const group = groupForRelativePath(scopeEntry.relativePath);
    const list = groups.get(group.outputPath) ?? {
      outputPath: group.outputPath,
      directory: group.directory,
      firstColumn: group.firstColumn,
      rows: [],
    };
    list.rows.push(toRow(scopeEntry.relativePath, group, entry));
    groups.set(group.outputPath, list);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, rows: sortRows(group.rows, group.directory) }))
    .sort((a, b) => a.outputPath.localeCompare(b.outputPath));
}

function groupForRelativePath(relativePath) {
  if (relativePath.startsWith('cat-cafe-skills/')) {
    return { outputPath: 'cat-cafe-skills/index.md', directory: 'cat-cafe-skills/', firstColumn: 'Path' };
  }
  const parts = relativePath.split('/');
  if (parts[0] === 'docs' && parts.length > 2) {
    const directory = `docs/${parts[1]}/`;
    return {
      outputPath: `${directory}index.md`,
      directory,
      firstColumn: parts[1] === 'discussions' ? 'Path' : 'ID',
    };
  }
  return { outputPath: 'docs/index.md', directory: 'docs/', firstColumn: 'Path' };
}

function toRow(relativePath, group, entry) {
  const descriptionMissing = !entry.description;
  const flags = [];
  if (descriptionMissing) {
    flags.push('description_missing', 'description_fallback_source=h1');
  }
  if (entry.description_source === 'model') {
    if (entry.description_generated_by)
      flags.push(`description_generated_by=${encodeFlagValue(entry.description_generated_by)}`);
    if (entry.description_generated_at)
      flags.push(`description_generated_at=${encodeFlagValue(entry.description_generated_at)}`);
    if (entry.description_confirmed_by)
      flags.push(`description_confirmed_by=${encodeFlagValue(entry.description_confirmed_by)}`);
  }

  return {
    relativePath,
    key:
      group.firstColumn === 'Path' ? relativePath.replace(group.directory, '') : deriveId(relativePath, entry, group),
    title: normalizeHomeBrandText(cleanTitle(entry.title_h1 ?? path.basename(relativePath, '.md'))),
    description: normalizeHomeBrandText(entry.description ?? '(待补)'),
    topics: normalizeHomeBrandText(entry.topics.join(', ')),
    author: entry.description_author ?? '—',
    updated: entry.description_updated_at ? entry.description_updated_at.slice(0, 10) : '—',
    source: entry.description_source ?? '—',
    flags: flags.length > 0 ? flags.join(', ') : '—',
  };
}

function renderIndexMarkdown(model, options) {
  const title = `${model.directory} Index`;
  const separatorFirst = model.firstColumn === 'Path' ? '------' : '----';
  const rows = model.rows
    .map((row) =>
      [row.key, row.title, row.description, row.topics, row.author, row.updated, row.source, row.flags]
        .map(escapeTableCell)
        .join(' | '),
    )
    .map((row) => `| ${row} |`)
    .join('\n');

  return [
    '---',
    'generated: true',
    'generated_from:',
    '  scope: profile_enforced',
    '  resolver: resolveDocsProfileScope',
    '  resolver_version: f243-resolver-v1',
    `  directory: ${model.directory}`,
    `generated_at: ${options.generatedAt}`,
    `generator_version: ${GENERATOR_VERSION}`,
    `profile_contract_version: ${PROFILE_CONTRACT_VERSION}`,
    '---',
    '',
    `# ${title}`,
    '',
    'Generated by F243. Do not hand-edit; run `node scripts/docs-discovery/generate-index.mjs --write`.',
    '',
    `| ${model.firstColumn} | Title | Description | Topics | Author | Updated | Source | Flags |`,
    `|${separatorFirst}|-------|-------------|--------|--------|---------|--------|-------|`,
    rows,
    '',
  ].join('\n');
}

function sortRows(rows, directory) {
  const pattern =
    directory === 'docs/features/' ? /^F(\d+)/ : directory === 'docs/decisions/' ? /^ADR-(\d+)/ : /^LL-(\d+)/;
  return [...rows].sort((a, b) => {
    const left = extractNumericId(a.key, pattern);
    const right = extractNumericId(b.key, pattern);
    if (left !== null && right !== null) return left - right;
    if (left !== null) return -1;
    if (right !== null) return 1;
    return a.key.localeCompare(b.key);
  });
}

function extractNumericId(value, pattern) {
  const match = value.match(pattern);
  return match ? Number.parseInt(match[1], 10) : null;
}

function deriveId(relativePath, entry, group) {
  if (group.directory === 'docs/features/' && entry.feature_ids[0]) return entry.feature_ids[0];
  const basename = path.basename(relativePath, '.md');
  const match = basename.match(/^(F\d+|ADR-\d+|LL-\d+)/);
  return match?.[1] ?? basename;
}

function cleanTitle(title) {
  return title.replace(/^F\d+:\s*/, '').trim();
}

function escapeTableCell(value) {
  return String(value || '—')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, ' ');
}

function encodeFlagValue(value) {
  return String(value).replaceAll('=', '%3D').replaceAll(',', '%2C').replaceAll('|', '%7C');
}

function normalizeHomeBrandText(value) {
  return String(value).replaceAll('Clowder AI Hub', 'Clowder AI Hub').replaceAll('Clowder AI', 'Clowder AI');
}

function stripGeneratedAt(content) {
  return content.replace(/^generated_at:\s*.*$/m, 'generated_at: <stripped>');
}

function isGeneratedIndex(content) {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return false;
  return (
    /^generated:\s*true$/m.test(frontmatter) &&
    /^generator_version:\s*f243-index-v1$/m.test(frontmatter) &&
    /^\s+resolver:\s*resolveDocsProfileScope$/m.test(frontmatter)
  );
}

function readGeneratedAt(content) {
  return (
    extractFrontmatter(content)
      ?.match(/^generated_at:\s*(.+)$/m)?.[1]
      ?.trim() ?? null
  );
}

function extractFrontmatter(content) {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? null;
}

function toRelative(repoRoot, absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      options.mode = 'check';
    } else if (arg === '--write') {
      options.mode = 'write';
    } else if (arg === '--repo-root') {
      options.repoRoot = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { mode: options.mode ?? 'check', repoRoot: options.repoRoot };
}

function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot());
    const result = generateIndexesForRepo(repoRoot, { mode: options.mode });
    if (result.changedPaths.length > 0) {
      console.log(`${options.mode === 'write' ? 'Updated' : 'Out of date'} F243 indexes:`);
      for (const changedPath of result.changedPaths) console.log(`  - ${changedPath}`);
    } else if (result.skippedPaths.length > 0) {
      console.log('F243 generated indexes are up to date for managed paths.');
    } else {
      console.log('F243 generated indexes are up to date.');
    }
    for (const skippedPath of result.skippedPaths) {
      console.warn(`Skipped hand-authored index: ${skippedPath}`);
    }
    if (!result.ok) process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
