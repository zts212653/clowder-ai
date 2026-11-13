import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Package-local import closure of the reviewed gh entry, including its scanners.
// Host API/MCP modules remain the existing executor-owned boundary, as in the packager.
export const GH_COHORT_FILES = Object.freeze([
  'packages/shared/src/deployment-defaults.ts',
  'packages/shared/src/deployment-profiles.json',
  'scripts/guarded-bin/gh',
  'scripts/lib/gh-read-cache.mjs',
  'scripts/lib/git-invocation.mjs',
  'scripts/lib/package-manager-invocation.mjs',
  'scripts/lib/secret-command-execution.mjs',
  'scripts/lib/secret-content-rules.mjs',
  'scripts/lib/secret-content-scan.mjs',
  'scripts/lib/secret-credential-paths.mjs',
  'scripts/lib/secret-curl-args.mjs',
  'scripts/lib/secret-gh-args.mjs',
  'scripts/lib/secret-gh-options.mjs',
  'scripts/lib/secret-image-payload.mjs',
  'scripts/lib/secret-outbound-args.mjs',
  'scripts/lib/secret-payload-files.mjs',
  'scripts/lib/secret-platform-auth.mjs',
  'scripts/lib/secret-send-options.mjs',
  'scripts/lib/secret-tool-io.mjs',
  'scripts/lib/secret-value-inspection.mjs',
  'scripts/lib/shell-code-inputs.mjs',
  'scripts/lib/shell-directory.mjs',
  'scripts/lib/shell-invocation.mjs',
  'scripts/lib/shell-lexical.mjs',
  'scripts/lib/shell-program-tokens.mjs',
  'scripts/lib/shell-text.mjs',
  'scripts/lib/shell-wrappers.mjs',
  'scripts/native-auth-effect.mjs',
  'scripts/native-effect-find-classifier.mjs',
  'scripts/native-effect-gh-cohort.mjs',
  'scripts/native-effect-git-fetch.mjs',
  'scripts/native-effect-github-classifier.mjs',
  'scripts/native-effect-heredoc-body.mjs',
  'scripts/native-effect-heredoc.mjs',
  'scripts/native-effect-http-classifier.mjs',
  'scripts/native-effect-interpreter-source.mjs',
  'scripts/native-effect-media-classifier.mjs',
  'scripts/native-effect-output-file-roles.mjs',
  'scripts/native-effect-program-selection.mjs',
  'scripts/native-effect-repository-classifier.mjs',
  'scripts/native-effect-sed-classifier.mjs',
  'scripts/native-effect-segment-locations.mjs',
  'scripts/native-effect-shell-classifier.mjs',
  'scripts/native-effect-shell-expansion.mjs',
  'scripts/native-effect-shell-tokenizer.mjs',
  'scripts/native-effect-sqlite-classifier.mjs',
  'scripts/native-effect-target-classifier.mjs',
  'scripts/native-effect-write-effects.mjs',
  'scripts/native-secret-policy.mjs',
  'scripts/native-secret-shell.mjs',
]);
const OWN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = 'packages/shared/src/deployment-defaults.ts';
const DEFAULTS_EQUIVALENT = new Map([
  ['52d58ca050c96d62785b72d7904fe371424fdf2bd016c323bd858ba27bf088e2', 'deployment-defaults-v1'],
  ['70215c672330b88b45e21aa4a922e83c278ac5c6bb14cd736dfa57c71755031e', 'deployment-defaults-v1'],
]);
const HOST_MODULES = [
  'packages/api/dist/config/platform-authentication.js',
  'packages/mcp-server/dist/secret-tool-guard.js',
];
const MAX_FILE = 64 * 1024;
const MAX_TOTAL = 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Published 234f66ae65 cohort, independently checked from immutable source.
// Source and deterministic stage normalize to the same digest. This permits
// the existing deployed wrapper in a delegation chain, never a mixed cohort.
const PREVIOUS_COHORT = 'e8ad0622c739c0b902a22f973659aafa811430da55c474b8959b814661c8d0fb';
// Reviewed #6899, merged as 0f473c7f36: existing deployments may still delegate
// through this exact 50-module source/stage cohort during a guard upgrade.
const PUBLISHED_6899_COHORT = '7bfcffb3257286345761350b492b776f7c97fed0301e26aa3248460b853e2e93';
const LEGACY_FILES = [
  ...GH_COHORT_FILES.filter((file) => file !== 'scripts/native-effect-gh-cohort.mjs'),
  'scripts/native-effect-invocation-targets.mjs',
].sort();
let ownCohort;

function boundedFile(path) {
  let fd;
  try {
    if (realpathSync(path) !== path) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE) return null;
    const bytes = Buffer.alloc(MAX_FILE + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return count <= MAX_FILE ? bytes.subarray(0, count) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function cohort(root, stage, files = GH_COHORT_FILES) {
  const result = new Map();
  let total = 0;
  for (const logical of files) {
    const emitted = stage ? logical.replace(/\.ts$/, '.mjs') : logical;
    const path = resolve(root, emitted);
    const bytes = boundedFile(path);
    if (!bytes || (total += bytes.length) > MAX_TOTAL) return null;
    if (logical === DEFAULTS) {
      const equivalent = DEFAULTS_EQUIVALENT.get(digest(bytes));
      if (!equivalent) return null;
      result.set(logical, equivalent);
      continue;
    }
    let text = bytes.toString('utf8').replaceAll('deployment-defaults.ts', 'deployment-defaults.mjs');
    // Installed packages retain the emitter's relative import coordinates.
    const importBase = stage ? '/cohort/packages/mcp-server/dist/runtime' : '/cohort';
    for (const host of HOST_MODULES) {
      const specifier = relative(dirname(resolve(importBase, emitted)), resolve('/cohort', host)).replaceAll('\\', '/');
      text = text.replaceAll(specifier, '<host:' + host + '>');
    }
    result.set(logical, digest(text));
  }
  return result;
}

/** A matching entry alone cannot attest the scanner imports it will execute.
 * Compare every package-local module with this guard's trusted cohort. */
export function verifiedGhCohort(entry, stage) {
  if (!entry.endsWith('/scripts/guarded-bin/gh')) return false;
  ownCohort ??= cohort(OWN_ROOT, !existsSync(resolve(OWN_ROOT, DEFAULTS)));
  if (!ownCohort) return false;
  const root = resolve(dirname(entry), '../..');
  const current = existsSync(resolve(root, 'scripts/native-effect-gh-cohort.mjs'));
  const selected = cohort(root, stage, current ? GH_COHORT_FILES : LEGACY_FILES);
  if (!selected) return false;
  if (current) {
    if (GH_COHORT_FILES.every((file) => selected.get(file) === ownCohort.get(file))) return true;
    return cohortDigest(selected, GH_COHORT_FILES) === PUBLISHED_6899_COHORT;
  }
  return cohortDigest(selected, LEGACY_FILES) === PREVIOUS_COHORT;
}

function cohortDigest(selected, files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file + '\0' + selected.get(file) + '\0');
  return hash.digest('hex');
}
