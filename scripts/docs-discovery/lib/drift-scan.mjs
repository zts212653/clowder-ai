import { execFileSync } from 'node:child_process';
import { loadProfileEntries } from '@cat-cafe/shared/profile-frontmatter-parser';
import { parse as parseYaml } from 'yaml';
import { resolveDocsProfileScope } from './scope-resolver.mjs';

const DEFAULT_THRESHOLD_MONTHS = 6;
const FRONTMATTER_DRIFT_FIELDS = ['status', 'topics', 'doc_kind', 'feature_ids', 'related_features'];

export function runScheduledDriftScan(repoRoot, options = {}) {
  const thresholdMonths = options.thresholdMonths ?? DEFAULT_THRESHOLD_MONTHS;
  const scope = resolveDocsProfileScope(repoRoot);
  const loaded = loadProfileEntries(scope.profile_enforced.map((entry) => entry.path));
  const entriesByPath = new Map(loaded.entries.map((entry) => [entry.path, entry]));
  const warnings = [];

  for (const target of scope.profile_enforced) {
    const entry = entriesByPath.get(target.path);
    if (!entry?.description_updated_at) continue;

    const descriptionUpdatedAt = Date.parse(entry.description_updated_at);
    if (Number.isNaN(descriptionUpdatedAt)) continue;

    const staleAfter = addMonths(new Date(descriptionUpdatedAt), thresholdMonths).getTime();
    const change = findMajorChangeAfter(repoRoot, target.relativePath, staleAfter);
    if (!change) continue;

    warnings.push({
      path: target.path,
      relativePath: target.relativePath,
      level: 'warn',
      code: 'f243/description-stale-after-doc-change',
      message:
        `description_updated_at predates a major doc change by more than ${thresholdMonths} months ` +
        `(${change.commit.slice(0, 8)} at ${change.committedAt}); review whether description still aligns`,
    });
  }

  return { ok: true, warnings };
}

function findMajorChangeAfter(repoRoot, relativePath, staleAfterMs) {
  for (const commit of listPathCommits(repoRoot, relativePath)) {
    const committedAtMs = Date.parse(commit.committedAt);
    if (Number.isNaN(committedAtMs) || committedAtMs <= staleAfterMs) continue;

    const pathPair = changedPathPairForCommit(repoRoot, commit.sha, commit.relativePath);
    const previousContent = readFileAtRevision(repoRoot, `${commit.sha}^`, pathPair.previousPath);
    const currentContent = readFileAtRevision(repoRoot, commit.sha, pathPair.currentPath);
    if (previousContent === null || currentContent === null) continue;
    if (isMajorDocChange(previousContent, currentContent)) {
      return { commit: commit.sha, committedAt: commit.committedAt };
    }
  }
  return null;
}

function listPathCommits(repoRoot, relativePath) {
  const output = runGit(repoRoot, ['log', '--follow', '--format=%H%x00%cI', '--name-status', '--', relativePath]);
  if (!output) return [];

  const commits = [];
  let current = null;
  let changeLines = [];

  function flushCurrent() {
    if (!current) return;
    commits.push({
      ...current,
      relativePath: pathFromNameStatus(changeLines) ?? relativePath,
    });
  }

  for (const line of output.split('\n')) {
    if (!line) continue;

    const [sha, committedAt] = line.split('\0');
    if (sha && committedAt) {
      flushCurrent();
      current = { sha, committedAt };
      changeLines = [];
      continue;
    }

    if (current) changeLines.push(line);
  }

  flushCurrent();
  return commits;
}

function pathFromNameStatus(lines) {
  for (const line of lines) {
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R') && parts[2]) return parts[2];
    if (parts[1]) return parts[1];
  }
  return null;
}

function changedPathPairForCommit(repoRoot, commitSha, relativePath) {
  const output = runGit(repoRoot, ['diff-tree', '--no-commit-id', '--name-status', '-M', '-r', commitSha]);
  for (const line of output.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R') && parts[2] === relativePath) {
      return { previousPath: parts[1], currentPath: parts[2] };
    }
    if (parts[1] === relativePath) {
      return { previousPath: relativePath, currentPath: relativePath };
    }
  }
  return { previousPath: relativePath, currentPath: relativePath };
}

function isMajorDocChange(previousContent, currentContent) {
  return (
    extractH1(previousContent) !== extractH1(currentContent) ||
    frontmatterDriftSnapshot(previousContent) !== frontmatterDriftSnapshot(currentContent)
  );
}

function frontmatterDriftSnapshot(content) {
  const block = extractFrontmatterBlock(content);
  if (block === null) return '{}';
  try {
    const parsed = parseYaml(block);
    if (!isRecord(parsed)) return '{}';
    const snapshot = {};
    for (const field of FRONTMATTER_DRIFT_FIELDS) {
      if (Object.hasOwn(parsed, field)) snapshot[field] = parsed[field];
    }
    return JSON.stringify(sortObject(snapshot));
  } catch {
    return JSON.stringify({ __invalidFrontmatter: block });
  }
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

function runGit(repoRoot, args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function extractH1(content) {
  const line = content.split(/\r?\n/).find((candidate) => /^#\s+/.test(candidate));
  return line ? line.replace(/^#\s+/, '').trim() : null;
}

function extractFrontmatterBlock(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? (match[1] ?? '').trim() : null;
}

function addMonths(date, months) {
  const copy = new Date(date.getTime());
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
