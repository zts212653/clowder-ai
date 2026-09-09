#!/usr/bin/env node
/**
 * F280: the runbooks that TELL a cat how to register tracking must not teach an interface the
 * server rejects.
 *
 * These files are execution surfaces, not prose: a cat follows them literally, so a retired
 * parameter here is a guaranteed runtime failure in merge-gate, not a documentation nit. They
 * drifted once already — the public contract lost `when` / `expiresAt` and three typed
 * predicates while every runbook kept prescribing them — and nothing noticed, because no check
 * read these files at all.
 *
 * Surfaces are DISCOVERED, never enumerated. The first version of this guard shipped a
 * hardcoded six-file list written from the files its author happened to have migrated; a
 * seventh registered runbook (refs/mcp-callbacks.md) kept teaching the complete old protocol
 * while the gate printed "6 surfaces clean". A guard whose scope is an author's memory
 * certifies the author's memory, not the repo.
 *
 * Internal predicate kinds are banned too: a caller who learns `pr_ci_terminal` from a runbook
 * will eventually pass it, which is the "pick the wrong internal name and get silence" failure
 * F280 exists to remove. Runbooks speak public event NAMES.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SKILL_ROOT = 'cat-cafe-skills';

/** A file that names either registration tool is teaching someone how to call it. */
export const TRACKING_REGISTRATION_TOOLS = ['cat_cafe_register_pr_tracking', 'cat_cafe_register_issue_tracking'];

/**
 * Every skill Markdown that mentions a registration tool is in scope — including files added
 * after this guard was written. That is the whole point: the failure mode being locked out is
 * "a new runbook teaches the retired protocol and no one notices".
 */
export function discoverTrackingRunbookSurfaces(root) {
  const skillDir = fileURLToPath(new URL(`${SKILL_ROOT}/`, root));
  // A symlinked mirror (cat-cafe-skills/.cat-cafe-shared-refs -> refs) exposes the same inode
  // under a second path. Counting both would inflate the reported surface count — the exact
  // species of evidence overstatement this guard exists to prevent — so dedupe by real path.
  const byRealPath = new Map();
  for (const entry of readdirSync(skillDir, { recursive: true, encoding: 'utf8' })) {
    const rel = entry.split('\\').join('/');
    if (!rel.endsWith('.md')) continue;
    const relPath = `${SKILL_ROOT}/${rel}`;
    const text = readFileSync(new URL(relPath, root), 'utf8');
    if (!TRACKING_REGISTRATION_TOOLS.some((tool) => text.includes(tool))) continue;
    const real = realpathSync(fileURLToPath(new URL(relPath, root)));
    const seen = byRealPath.get(real);
    if (seen === undefined || relPath.length < seen.length) byRealPath.set(real, relPath);
  }
  const surfaces = [...byRealPath.values()].sort();
  // Fail closed: a moved/renamed skill tree must break the gate loudly rather than quietly
  // scanning nothing and reporting success.
  if (surfaces.length === 0) {
    throw new Error(
      `tracking-runbook-contract: discovered 0 surfaces under ${SKILL_ROOT}/ — refusing to report a vacuous PASS`,
    );
  }
  return surfaces;
}

/**
 * Parameter names are matched in every shape a reader could copy: bare (`when=`), YAML
 * (`when: [`), JSON (`"when": [`) and single-quoted (`'when': [`).
 *
 * Plain English carries `when` constantly — every skill front-matter says "Use when: …" — so a
 * key match additionally requires an opening `[`/`{`. A guard that fires on prose gets weakened
 * until it fires on nothing.
 */
const quotedKey = (name) => new RegExp(`(?<![\\w-])["'\`]?${name}["'\`]?\\s*:\\s*[[{]`);
const assignedKey = (name) => new RegExp(`(?<![\\w-])["'\`]?${name}["'\`]?\\s*=`);

const RETIRED_PATTERNS = [
  { name: 'when= parameter', re: assignedKey('when') },
  { name: 'when key (YAML/JSON/quoted)', re: quotedKey('when') },
  { name: '`when` parameter', re: /`when`/ },
  { name: 'expiresAt parameter', re: /\bexpiresAt\b/ },
  { name: 'autoRenew parameter', re: /\bautoRenew\b/ },
  { name: 'triggerCommentId parameter', re: /\btriggerCommentId\b/ },
  { name: 'reviewThreadIds parameter', re: /\breviewThreadIds\b/ },
  { name: 'authorLogins parameter', re: /\bauthorLogins\b/ },
  {
    name: 'internal predicate kind',
    re: /\b(?:pr|issue)_[a-z_]*(?:changed|added|terminal|conflicting|behind|available|commented|interaction)\b/,
  },
  { name: 'retired vocabulary', re: /typed (?:predicate|wait)/ },
];

export function scanTrackingRunbookText(content, relPath) {
  const violations = [];
  content.split('\n').forEach((line, index) => {
    for (const { name, re } of RETIRED_PATTERNS) {
      if (re.test(line)) violations.push(`${relPath}:${index + 1}: ${name} — ${line.trim().slice(0, 90)}`);
    }
  });
  return violations;
}

export function scanTrackingRunbooks(root) {
  return discoverTrackingRunbookSurfaces(root).flatMap((surface) =>
    scanTrackingRunbookText(readFileSync(new URL(surface, root), 'utf8'), surface),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('..', import.meta.url);
  const surfaces = discoverTrackingRunbookSurfaces(root);
  const violations = scanTrackingRunbooks(root);
  if (violations.length > 0) {
    console.error(`FAIL tracking-runbook-contract: ${violations.length} retired reference(s)`);
    for (const violation of violations) console.error(`  - ${violation}`);
    console.error('\nRunbooks speak public EVENT NAMES (review_decision, inline_comment, bot_interaction, …).');
    process.exit(1);
  }
  console.log(`PASS tracking-runbook-contract: ${surfaces.length} discovered execution surfaces clean`);
  for (const surface of surfaces) console.log(`  - ${surface}`);
}
