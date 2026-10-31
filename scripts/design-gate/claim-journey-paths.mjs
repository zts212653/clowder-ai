import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Dependency-free view of the committed design-gate claim contracts for the gate
// route classifier: which browser journey files the claims bind. The classifier
// runs from a control-plane snapshot under a temp directory, so this module must
// import nothing beyond node built-ins (no `typescript`, no sibling helpers).

export const DESIGN_GATE_CLAIMS_DIRECTORY = 'docs/design-gate-claims';
export const DEFAULT_ENTRY_JOURNEY_HARNESS = 'packages/web/test/browser/default-entry-journey.harness.mjs';

function claimFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...claimFiles(entryPath));
    if (entry.isFile() && entry.name.endsWith('.json')) files.push(entryPath);
  }
  return files.sort();
}

// A journey file has one repository identity even when a claim spells it with
// `./`, `..` or a symlink. The static checker and route classifier both use
// this identity; the browser harness applies the same realpath-relative rule at
// runtime so aliases cannot make the expected-journey set disappear.
export function canonicalJourneyTestPath(repoRoot, testPath) {
  if (typeof testPath !== 'string' || !testPath.trim()) return undefined;
  const root = realpathSync(resolve(repoRoot));
  const candidate = resolve(root, testPath.trim());
  const canonical = existsSync(candidate) ? realpathSync(candidate) : candidate;
  const repoRelative = relative(root, canonical).split(sep).join('/');
  if (!repoRelative || repoRelative === '..' || repoRelative.startsWith('../') || isAbsolute(repoRelative)) {
    return undefined;
  }
  return repoRelative;
}

// Journey test paths bound by committed claims. Unreadable contracts are skipped
// here on purpose: the claims directory itself always forces the full route, and
// `check:design-gate-real-interaction` is where a broken contract turns red.
export function listDefaultEntryJourneyPaths(repoRoot, claimsDirectory = DESIGN_GATE_CLAIMS_DIRECTORY) {
  const directory = resolve(repoRoot, claimsDirectory);
  if (!existsSync(directory)) return [];
  const paths = new Set();
  for (const file of claimFiles(directory)) {
    let contract;
    try {
      contract = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const testPath = canonicalJourneyTestPath(
      repoRoot,
      contract?.claims?.productIntegration?.defaultEntryJourney?.testPath,
    );
    if (testPath) paths.add(testPath);
  }
  return [...paths].sort();
}

export function isDesignGateJourneyPath(filePath, journeyPaths = []) {
  return (
    filePath.startsWith(`${DESIGN_GATE_CLAIMS_DIRECTORY}/`) ||
    filePath === DEFAULT_ENTRY_JOURNEY_HARNESS ||
    journeyPaths.includes(filePath)
  );
}

export const DESIGN_GATE_JOURNEY_REASON =
  'design-gate claim contracts bind default-entry browser journeys that only the full gate executes';

// Committed claims bind default-entry browser journeys; only the full route runs
// `test:browser`, so a claim contract, the journey harness or a bound journey file
// cannot stay targeted.
export function designGateJourneyReason(prPaths, journeyPaths = []) {
  return prPaths.some((file) => isDesignGateJourneyPath(file, journeyPaths)) ? DESIGN_GATE_JOURNEY_REASON : null;
}
