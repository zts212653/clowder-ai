import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const metadataPattern = /(^|\/)(\.?biome\.jsonc?|\.gitignore|\.editorconfig|package\.json|pnpm-lock\.yaml)$/;
const configPattern = /(^|\/)\.?biome\.jsonc?$/;
// Audited against `biome explain` from the pinned 2.4.1 binary. Nursery,
// explicit domains and other versions retain the complete index below.
const crossFileRules = new Set([
  'noPrivateImports',
  'noUndeclaredDependencies',
  'noUnresolvedImports',
  'useImportExtensions',
  'useJsonImportAttributes',
  'noDeprecatedImports',
  'noImportCycles',
]);

function git(args, input) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, input });
}

function rulesNeedCompleteIndex(rules) {
  if (!rules || typeof rules !== 'object') return true;
  // A group severity enables rules without naming them, including cross-file
  // rules. Only object-valued groups can be inspected by rule name below.
  return Object.entries(rules).some(
    ([name, setting]) => name !== 'recommended' && (setting === null || typeof setting !== 'object'),
  );
}

function needsCompleteIndex(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    if (['extends', 'plugins', 'domains', 'nursery'].includes(key) || crossFileRules.has(key)) return true;
    if (key === 'root' && child !== true) return true;
    if (key === 'rules' && rulesNeedCompleteIndex(child)) return true;
    if (key === 'all' && child === true) return true;
    if (key === 'preset' && child === 'all') return true;
    return needsCompleteIndex(child);
  });
}

function configurationReason(path) {
  let config;
  try {
    config = JSON.parse(git(['show', `:${path}`]));
  } catch {
    return `configuration requires Biome parsing: ${path}`;
  }
  return needsCompleteIndex(config) ? `configuration may require other index files: ${path}` : undefined;
}

function completeIndexReason(entries, staged) {
  const installed = JSON.parse(readFileSync('node_modules/@biomejs/biome/package.json', 'utf8'));
  if (installed.version !== '2.4.1') return 'Biome version outside the audited file-local configuration';
  for (const { path, mode } of entries) {
    if (mode === '120000' && staged.has(path)) return `staged symlink may require another index file: ${path}`;
    // Turborepo rules can be enabled by package discovery, without an explicit
    // rule/domain in biome.json, and may follow turbo configuration inheritance.
    if (/(^|\/)turbo\.jsonc?$/.test(path)) return `Turborepo configuration: ${path}`;
    if (!metadataPattern.test(path)) continue;
    if (mode === '120000') return `configuration metadata symlink: ${path}`;
    if (!configPattern.test(path)) continue;
    const reason = configurationReason(path);
    if (reason) return reason;
  }
  return undefined;
}

// The caller owns an empty temporary directory and its cleanup. Never materialize
// into the worktree or reuse a directory containing stale/live input files.
if (!process.argv[2]) throw new Error('Missing Biome index snapshot destination');
const destination = resolve(process.argv[2]);
if (!lstatSync(destination).isDirectory() || readdirSync(destination).length !== 0) {
  throw new Error('Biome index snapshot destination must be an empty directory');
}
const entries = git(['ls-files', '--stage', '-z'])
  .split('\0')
  .filter(Boolean)
  .map((record) => {
    const tab = record.indexOf('\t');
    const [mode, , stage] = record.slice(0, tab).split(' ');
    if (stage !== '0') throw new Error('Cannot lint an unmerged index');
    return { mode, path: record.slice(tab + 1) };
  });
const checkout = ['checkout-index', '--ignore-skip-worktree-bits', `--prefix=${destination}${sep}`];
const staged = new Set(git(['diff', '--cached', '--name-only', '--diff-filter=d', '-z']).split('\0'));
const reason = completeIndexReason(entries, staged);
if (reason) {
  console.error(`Biome index snapshot: using complete index (${reason})`);
  git([...checkout, '--all']);
} else {
  const selected = entries.filter(({ path }) => staged.has(path) || metadataPattern.test(path));
  git([...checkout, '--stdin', '-z'], selected.map(({ path }) => `${path}\0`).join(''));
}
