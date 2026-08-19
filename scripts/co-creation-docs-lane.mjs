#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { posix as pathPosix } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CONFLICT_VALUES = new Set(['none', 'detected', 'unknown']);
const REVERSIBILITY_VALUES = new Set(['one_commit', 'high', 'unknown']);
const REQUIRE_VALUES = new Set(['direct_push', 'pull_request', 'regular_development']);

export const CO_CREATION_DOC_INCLUDE_GLOBS = ['docs/*.md', 'docs/**/*.md'];

const GOVERNANCE_PATHS = new Set(['docs/SOP.md', 'docs/VISION.md', 'docs/lessons-learned.md']);
const GOVERNANCE_PREFIXES = ['docs/architecture/ownership/', 'docs/canon/', 'docs/decisions/'];
const DIRECT_MAIN_SHARED_STATE_PATHS = new Set(['docs/BACKLOG.md']);

function normalizedPaths(paths) {
  const normalized = paths
    .map((path) => path.trim().replaceAll('\\', '/'))
    .filter(Boolean)
    .map((path) => pathPosix.normalize(path).replace(/^\.\//, ''))
    .filter((path) => path !== '.');
  return [...new Set(normalized)].sort();
}

export function isCoCreationDocPath(path) {
  return path.startsWith('docs/') && path.endsWith('.md');
}

export function isGovernanceDocPath(path) {
  return GOVERNANCE_PATHS.has(path) || GOVERNANCE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function isDirectMainSharedStatePath(path) {
  return DIRECT_MAIN_SHARED_STATE_PATHS.has(path);
}

export function classifyCoCreationDocsLane({ changedFiles, conflict, reversibility }) {
  const files = normalizedPaths(changedFiles ?? []);
  if (files.length === 0) throw new Error('co-creation docs classification requires at least one changed file');
  if (!CONFLICT_VALUES.has(conflict)) {
    throw new Error(`conflict must be one of: ${[...CONFLICT_VALUES].join(', ')}`);
  }
  if (!REVERSIBILITY_VALUES.has(reversibility)) {
    throw new Error(`reversibility must be one of: ${[...REVERSIBILITY_VALUES].join(', ')}`);
  }

  const nonDocFiles = files.filter((path) => !isCoCreationDocPath(path));
  const governanceFiles = files.filter((path) => isGovernanceDocPath(path));
  const directMainSharedStateFiles = files.filter((path) => isDirectMainSharedStatePath(path));
  const validation = ['node scripts/check-frontmatter.mjs --strict-delta --base origin/main'];
  if (files.some((path) => path.startsWith('docs/features/'))) {
    validation.push('node scripts/check-feature-truth.mjs');
  }

  if (nonDocFiles.length > 0) {
    return {
      lane: 'regular_development',
      delivery: 'pull_request',
      cloudReview: 'required',
      fullGate: 'required',
      changedFiles: files,
      nonDocFiles,
      governanceFiles,
      directMainSharedStateFiles,
      validation: ['pnpm gate'],
      reasons: ['first_party_or_non_doc_change'],
    };
  }

  const reasons = [];
  if (governanceFiles.length > 0) reasons.push('governance_risk');
  if (conflict === 'detected') reasons.push('conflict_detected');
  if (conflict === 'unknown') reasons.push('conflict_unknown');
  if (reversibility === 'high') reasons.push('reversibility_high');
  if (reversibility === 'unknown') reasons.push('reversibility_unknown');

  return {
    lane: 'co_creation_docs',
    delivery: reasons.length === 0 ? 'direct_push' : 'pull_request',
    cloudReview: 'skip',
    fullGate: 'skip',
    changedFiles: files,
    nonDocFiles,
    governanceFiles,
    directMainSharedStateFiles,
    validation,
    reasons,
  };
}

export function collectChangedFiles({ repoRoot = process.cwd(), base = 'origin/main', runGit } = {}) {
  const git =
    runGit ??
    ((args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const committed = git(['diff', '--name-only', `${base}...HEAD`]);
  const unstaged = git(['diff', '--name-only']);
  const staged = git(['diff', '--name-only', '--cached']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return normalizedPaths(`${committed}\n${unstaged}\n${staged}\n${untracked}`.split(/\r?\n/));
}

function parseArgs(argv) {
  const options = {
    base: 'origin/main',
    conflict: 'unknown',
    reversibility: 'unknown',
    require: null,
    files: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    if (flag === '--help' || flag === '-h') return { ...options, help: true };
    if (!['--base', '--conflict', '--reversibility', '--require', '--files'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    index += 1;
    const key = flag.slice(2);
    if (key === 'require' && !REQUIRE_VALUES.has(value)) {
      throw new Error(`--require must be one of: ${[...REQUIRE_VALUES].join(', ')}`);
    }
    options[key] = key === 'files' ? value.split(',') : value;
  }
  return options;
}

function usage() {
  return `Usage: node scripts/co-creation-docs-lane.mjs [options]

Options:
  --base <ref>                    Diff base (default: origin/main)
  --files <comma-separated>       Explicit paths instead of reading git state
  --conflict none|detected|unknown
  --reversibility one_commit|high|unknown
  --require direct_push|pull_request|regular_development

The classifier never uses line count. Unknown conflict or reversibility fails
closed to a pull request. Non-doc or first-party execution changes stay on the
regular development SOP.`;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const changedFiles = options.files ?? collectChangedFiles({ base: options.base });
    const result = classifyCoCreationDocsLane({
      changedFiles,
      conflict: options.conflict,
      reversibility: options.reversibility,
    });
    console.log(JSON.stringify(result, null, 2));

    if (options.require) {
      const actual = options.require === 'regular_development' ? result.lane : result.delivery;
      if (actual !== options.require) {
        console.error(`required ${options.require}, classifier returned ${actual}`);
        process.exitCode = 2;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) main();
