#!/usr/bin/env node
/**
 * F244 Phase D AC-D4 — Stale/sunset tip detection.
 *
 * Scans the capability tips inventory for:
 * 1. Broken sourceRef (path not found / anchor not found)
 * 2. Feature sunset (referenced feature doc has `status: sunset|closed|archived`)
 *
 * Groups findings by owner for actionable output.
 *
 * Usage:
 *   node scripts/check-capability-tips-stale.mjs [--repo-root <path>] [--json]
 *
 * Exit codes:
 *   0  — no stale tips found
 *   1  — stale tips detected (or inventory load error)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const DEFAULT_INVENTORY_PATH = 'packages/web/src/lib/capability-tips.seed.json';

// ── Feature status detection ───────────────────────────────────────────────

const SUNSET_STATUS_RE = /^status\s*:\s*(sunset|closed|archived|deprecated|done)\b/im;

/**
 * Check whether a feature doc is sunset/closed/archived.
 * Returns the status string if sunset, null otherwise.
 */
export function detectFeatureStatus(repoRoot, filePath) {
  if (!/^docs\/features\/F\d{3,4}-.+\.md$/.test(filePath)) return null;

  const absPath = resolve(repoRoot, filePath);
  if (!existsSync(absPath)) return null;

  const content = readFileSync(absPath, 'utf8');
  // Check YAML frontmatter first
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (frontmatter) {
    const match = frontmatter[1].match(SUNSET_STATUS_RE);
    if (match) return match[1];
  }

  // Check inline status markers (e.g. `Status: sunset`)
  const inlineMatch = content.match(SUNSET_STATUS_RE);
  if (inlineMatch) return inlineMatch[1];

  return null;
}

// ── sourceRef validation ───────────────────────────────────────────────────

/**
 * @typedef {'path_missing' | 'anchor_missing' | 'feature_sunset'} StaleReason
 *
 * @typedef {Object} StaleFinding
 * @property {string} tipId
 * @property {string} owner
 * @property {StaleReason} reason
 * @property {string} field - Which sourceRef field (sourceRef / structureSource / bodySource)
 * @property {string} path
 * @property {string} anchor
 * @property {string} [sunsetStatus] - Only present when reason = feature_sunset
 */

/**
 * Check one sourceRef field for staleness.
 * @returns {StaleFinding[]}
 */
function checkSourceRef(repoRoot, tipId, owner, fieldName, sourceRef) {
  /** @type {StaleFinding[]} */
  const findings = [];
  if (!sourceRef || typeof sourceRef.path !== 'string' || typeof sourceRef.anchor !== 'string') {
    return findings; // Schema validation catches this; not our concern
  }

  const absPath = resolve(repoRoot, sourceRef.path);

  // 1. Path existence
  if (!existsSync(absPath)) {
    findings.push({
      tipId,
      owner,
      reason: 'path_missing',
      field: fieldName,
      path: sourceRef.path,
      anchor: sourceRef.anchor,
    });
    return findings; // Can't check anchor or sunset if file doesn't exist
  }

  // 2. Anchor existence
  const content = readFileSync(absPath, 'utf8');
  if (!content.includes(sourceRef.anchor)) {
    findings.push({
      tipId,
      owner,
      reason: 'anchor_missing',
      field: fieldName,
      path: sourceRef.path,
      anchor: sourceRef.anchor,
    });
  }

  // 3. Feature sunset detection
  const sunsetStatus = detectFeatureStatus(repoRoot, sourceRef.path);
  if (sunsetStatus) {
    findings.push({
      tipId,
      owner,
      reason: 'feature_sunset',
      field: fieldName,
      path: sourceRef.path,
      anchor: sourceRef.anchor,
      sunsetStatus,
    });
  }

  return findings;
}

// ── Main check ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} StaleReport
 * @property {boolean} ok - true if no stale findings
 * @property {StaleFinding[]} findings
 * @property {{ [owner: string]: StaleFinding[] }} byOwner
 * @property {{ path_missing: number, anchor_missing: number, feature_sunset: number }} summary
 */

/**
 * Check all tips in inventory for staleness.
 * @param {string} [repoRoot]
 * @param {{ inventoryPath?: string }} [options]
 * @returns {StaleReport}
 */
export function checkCapabilityTipsStale(repoRoot = defaultRepoRoot, options = {}) {
  const inventoryPath = options.inventoryPath ?? DEFAULT_INVENTORY_PATH;
  const absInventory = resolve(repoRoot, inventoryPath);

  if (!existsSync(absInventory)) {
    return {
      ok: false,
      findings: [],
      byOwner: {},
      summary: { path_missing: 0, anchor_missing: 0, feature_sunset: 0 },
      error: `inventory not found: ${inventoryPath}`,
    };
  }

  const tips = JSON.parse(readFileSync(absInventory, 'utf8'));
  if (!Array.isArray(tips)) {
    return {
      ok: false,
      findings: [],
      byOwner: {},
      summary: { path_missing: 0, anchor_missing: 0, feature_sunset: 0 },
      error: 'inventory must be an array',
    };
  }

  /** @type {StaleFinding[]} */
  const findings = [];

  // De-duplicate: same tipId + same reason + same path = one finding
  const seen = new Set();

  for (const tip of tips) {
    if (!tip || typeof tip !== 'object') continue;
    const tipId = tip.id ?? '(unknown)';
    const owner = tip.owner ?? '(no owner)';

    for (const field of ['sourceRef', 'structureSource', 'bodySource']) {
      const results = checkSourceRef(repoRoot, tipId, owner, field, tip[field]);
      for (const f of results) {
        const key = `${f.tipId}:${f.reason}:${f.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push(f);
        }
      }
    }
  }

  // Group by owner
  /** @type {{ [owner: string]: StaleFinding[] }} */
  const byOwner = {};
  for (const f of findings) {
    (byOwner[f.owner] ??= []).push(f);
  }

  // Summary counts
  const summary = { path_missing: 0, anchor_missing: 0, feature_sunset: 0 };
  for (const f of findings) {
    summary[f.reason] += 1;
  }

  return { ok: findings.length === 0, findings, byOwner, summary };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function formatReport(report) {
  if (report.error) return `ERROR: ${report.error}`;
  if (report.ok) return 'PASS check-capability-tips-stale: no stale tips found';

  const lines = [
    `STALE check-capability-tips-stale: ${report.findings.length} issue(s) found`,
    `  path_missing: ${report.summary.path_missing} | anchor_missing: ${report.summary.anchor_missing} | feature_sunset: ${report.summary.feature_sunset}`,
    '',
  ];

  for (const [owner, ownerFindings] of Object.entries(report.byOwner).sort()) {
    lines.push(`  Owner: ${owner} (${ownerFindings.length} issue(s))`);
    for (const f of ownerFindings) {
      const extra = f.sunsetStatus ? ` [status: ${f.sunsetStatus}]` : '';
      lines.push(`    - ${f.tipId}: ${f.reason} — ${f.field} → ${f.path}#${f.anchor}${extra}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function parseArgs(argv) {
  let repoRoot = defaultRepoRoot;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo-root' && argv[i + 1]) {
      repoRoot = resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--json') {
      json = true;
    }
  }
  return { repoRoot, json };
}

function main() {
  const { repoRoot, json } = parseArgs(process.argv.slice(2));
  const report = checkCapabilityTipsStale(repoRoot);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
