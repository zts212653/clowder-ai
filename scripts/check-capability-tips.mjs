#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');
const DEFAULT_INVENTORY_PATH = 'packages/web/src/lib/capability-tips.seed.json';
const CAPABILITY_TIP_KINDS = new Set(['capability', 'magic_word', 'workflow', 'feature', 'status_help']);
const CAPABILITY_TIP_CONTEXTS = new Set([
  'thinking',
  'waiting_external',
  'review',
  'feature_dev',
  'merge_gate',
  'eval',
  'long_running',
  'concierge_idle',
  'concierge_open',
  'pet_waiting_for_user',
]);
const CAPABILITY_TIP_AUDIENCES = new Set(['cvo', 'developer', 'maintainer', 'all']);
const ACTION_REQUIRED_KINDS = new Set(['capability', 'workflow', 'feature']);
const ACTION_TYPES = new Set(['open_concierge_draft', 'open_source', 'open_guide', 'open_capability_surface']);
const TIP_KEYS = new Set([
  'id',
  'kind',
  'sourceRef',
  'structureSource',
  'bodySource',
  'contexts',
  'audience',
  'body',
  'action',
  'owner',
]);
const ACTION_KEYS = {
  open_concierge_draft: new Set(['type', 'label', 'draftPrompt']),
  open_source: new Set(['type', 'label', 'sourceRef']),
  open_guide: new Set(['type', 'label', 'guideId']),
  open_capability_surface: new Set(['type', 'label', 'surfaceId']),
};
const FAKE_PROGRESS_RE = /就快好了|快好了|马上完成|马上好|马上就好|即将完成/u;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isSourceRef(value) {
  return (
    isObject(value) &&
    typeof value.path === 'string' &&
    value.path.length > 0 &&
    typeof value.anchor === 'string' &&
    value.anchor.length > 0
  );
}

function formatAllowed(allowedValues) {
  return [...allowedValues].join(', ');
}

function validateAllowedKeys(id, objectName, value, allowedKeys, errors) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${id}: ${objectName} has unknown field "${key}"`);
    }
  }
}

function validateEnumArray(id, fieldName, value, allowedValues, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${id}: ${fieldName} is required`);
    return;
  }

  for (const item of value) {
    if (typeof item !== 'string') {
      errors.push(`${id}: ${fieldName} values must be strings`);
    } else if (!allowedValues.has(item)) {
      errors.push(`${id}: ${fieldName} contains unknown value "${item}" (allowed: ${formatAllowed(allowedValues)})`);
    }
  }
}

function validateSourceRef(repoRoot, tipId, fieldName, sourceRef, errors, warnings) {
  if (!isSourceRef(sourceRef)) {
    errors.push(`${tipId}: ${fieldName} must include path and anchor`);
    return;
  }

  const targetPath = resolve(repoRoot, sourceRef.path);
  if (!existsSync(targetPath)) {
    // Path-not-found is a soft issue: the tip renders fine without its source
    // file.  In the public export some source paths are intentionally excluded
    // (e.g. cat-cafe-skills/opensource-ops/ per KD-5).  Treat as warning so
    // the gate doesn't block on referential gaps that are by-design.
    (warnings ?? errors).push(`${tipId}: ${fieldName} path not found: ${sourceRef.path}`);
    return;
  }

  const content = readFileSync(targetPath, 'utf8');
  if (!content.includes(sourceRef.anchor)) {
    // Anchor mismatch is soft when a warnings collector exists: the public
    // export sanitizer may transform content (Chinese → English branding),
    // making source-repo anchors invalid in the export copy.
    (warnings ?? errors).push(`${tipId}: ${fieldName} anchor not found in ${sourceRef.path}: ${sourceRef.anchor}`);
  }
}

function validateRequiredFields(id, tip) {
  const errors = [];
  if (typeof tip.id !== 'string') {
    errors.push(`${id}: id must be a string`);
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(tip.id)) {
    errors.push(`${id}: id must be kebab-case`);
  }
  if (typeof tip.kind !== 'string') {
    errors.push(`${id}: kind is required`);
  } else if (!CAPABILITY_TIP_KINDS.has(tip.kind)) {
    errors.push(`${id}: kind contains unknown value "${tip.kind}" (allowed: ${formatAllowed(CAPABILITY_TIP_KINDS)})`);
  }
  validateEnumArray(id, 'contexts', tip.contexts, CAPABILITY_TIP_CONTEXTS, errors);
  validateEnumArray(id, 'audience', tip.audience, CAPABILITY_TIP_AUDIENCES, errors);
  if (typeof tip.owner !== 'string' || tip.owner.length === 0) errors.push(`${id}: owner is required`);
  if (typeof tip.body !== 'string' || tip.body.trim().length === 0) {
    errors.push(`${id}: body is required`);
  } else if (tip.body.length < 12 || tip.body.length > 140) {
    errors.push(`${id}: body must be 12-140 characters`);
  }
  return errors;
}

function validateActionShape(id, action) {
  const errors = [];
  if (!isObject(action)) {
    errors.push(`${id}: action must be typed`);
    return errors;
  }

  if (typeof action.type !== 'string') {
    errors.push(`${id}: action must be typed`);
    return errors;
  }

  if (!ACTION_TYPES.has(action.type)) {
    errors.push(`${id}: action contains unknown type "${action.type}" (allowed: ${formatAllowed(ACTION_TYPES)})`);
    return errors;
  }

  validateAllowedKeys(id, `${action.type} action`, action, ACTION_KEYS[action.type], errors);
  if (typeof action.label !== 'string' || action.label.length === 0) {
    errors.push(`${id}: action label is required`);
  }

  if (
    action.type === 'open_concierge_draft' &&
    action.draftPrompt !== undefined &&
    (typeof action.draftPrompt !== 'string' || action.draftPrompt.length === 0)
  ) {
    errors.push(`${id}: open_concierge_draft action draftPrompt must be a non-empty string`);
  }
  if (action.type === 'open_source' && action.sourceRef !== undefined && !isSourceRef(action.sourceRef)) {
    errors.push(`${id}: open_source action sourceRef must include path and anchor`);
  }
  if (action.type === 'open_guide' && (typeof action.guideId !== 'string' || action.guideId.length === 0)) {
    errors.push(`${id}: open_guide action requires guideId`);
  }
  if (
    action.type === 'open_capability_surface' &&
    (typeof action.surfaceId !== 'string' || action.surfaceId.length === 0)
  ) {
    errors.push(`${id}: open_capability_surface action requires surfaceId`);
  }

  return errors;
}

function validateActionAndBody(id, tip) {
  const errors = [];
  if (typeof tip.body === 'string' && FAKE_PROGRESS_RE.test(tip.body)) {
    errors.push(`${id}: fake progress wording is not allowed`);
  }
  if (ACTION_REQUIRED_KINDS.has(tip.kind) && !tip.action) {
    errors.push(`${id}: ${tip.kind} requires an action`);
  }
  if (tip.action !== undefined) {
    errors.push(...validateActionShape(id, tip.action));
  }
  return errors;
}

function validateTip(repoRoot, tip, index) {
  const id = isObject(tip) && typeof tip.id === 'string' ? tip.id : `tip[${index}]`;
  if (!isObject(tip)) {
    return { errors: [`${id}: tip must be an object`], warnings: [] };
  }

  const unknownFieldErrors = [];
  validateAllowedKeys(id, 'tip', tip, TIP_KEYS, unknownFieldErrors);
  const errors = [...validateRequiredFields(id, tip), ...validateActionAndBody(id, tip)];
  errors.push(...unknownFieldErrors);
  const warnings = [];
  validateSourceRef(repoRoot, id, 'sourceRef', tip.sourceRef, errors, warnings);
  validateSourceRef(repoRoot, id, 'structureSource', tip.structureSource, errors, warnings);
  validateSourceRef(repoRoot, id, 'bodySource', tip.bodySource, errors, warnings);

  return { errors, warnings };
}

function loadInventory(repoRoot, inventoryPath) {
  const resolved = resolve(repoRoot, inventoryPath);
  if (!existsSync(resolved)) {
    return { tips: [], errors: [`inventory not found: ${inventoryPath}`] };
  }

  const raw = readJson(resolved);
  if (!Array.isArray(raw)) {
    return { tips: [], errors: ['inventory must be an array'] };
  }
  return { tips: raw, errors: [] };
}

function isContributionRelevantFile(filePath) {
  return (
    /^docs\/features\/F\d{3,4}-.+\.md$/.test(filePath) ||
    /^guides\/(?:registry|flows\/.+)\.ya?ml$/.test(filePath) ||
    /^cat-cafe-skills\/[^/]+\/SKILL\.md$/.test(filePath)
  );
}

function fileHasTipsExemption(repoRoot, filePath) {
  const resolved = resolve(repoRoot, filePath);
  if (!existsSync(resolved)) return false;
  const content = readFileSync(resolved, 'utf8');
  const exemptionRe = /^tips_exempt\s*:\s*\S.*$/im;

  if (/\.md$/i.test(filePath)) {
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    return frontmatter ? exemptionRe.test(frontmatter[1] ?? '') : false;
  }

  if (/\.ya?ml$/i.test(filePath)) {
    return exemptionRe.test(content);
  }

  return false;
}

function tipReferencesPath(tip, filePath) {
  return isSourceRef(tip.sourceRef) && tip.sourceRef.path === filePath;
}

function getGitChangedFiles(repoRoot) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRT', 'origin/main...HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return { ok: true, files };
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    return {
      ok: false,
      error: `changed-file discovery failed; fetch origin/main or pass --changed-file explicitly${detail}`,
    };
  }
}

export function checkCapabilityTipsForRepo(repoRoot = defaultRepoRoot, options = {}) {
  const inventoryPath = options.inventoryPath ?? DEFAULT_INVENTORY_PATH;
  const changedFileResult = Array.isArray(options.changedFiles)
    ? { ok: true, files: options.changedFiles }
    : getGitChangedFiles(repoRoot);
  const { tips, errors } = loadInventory(repoRoot, inventoryPath);
  const allErrors = [...errors];
  const allWarnings = [];
  // Changed-file discovery failure (e.g. shallow clone without origin/main)
  // is a soft issue: tip format/schema validation still runs; only the
  // "new feature doc without matching tip" coverage check is skipped.
  if (!changedFileResult.ok) allWarnings.push(changedFileResult.error);
  const changedFiles = changedFileResult.ok ? changedFileResult.files : [];
  const seenIds = new Set();

  tips.forEach((tip, index) => {
    const result = validateTip(repoRoot, tip, index);
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
    if (isObject(tip) && typeof tip.id === 'string') {
      if (seenIds.has(tip.id)) allErrors.push(`duplicate tip id: ${tip.id}`);
      seenIds.add(tip.id);
    }
  });

  for (const filePath of changedFiles.filter(isContributionRelevantFile)) {
    if (fileHasTipsExemption(repoRoot, filePath)) continue;
    if (tips.some((tip) => tipReferencesPath(tip, filePath))) continue;
    allErrors.push(`${filePath}: missing capability tip or tips_exempt`);
  }

  return { ok: allErrors.length === 0, errors: allErrors, warnings: allWarnings };
}

function parseArgs(argv) {
  const changedFiles = [];
  let repoRoot = defaultRepoRoot;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-root' && argv[i + 1]) {
      repoRoot = resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--changed-file' && argv[i + 1]) {
      changedFiles.push(argv[i + 1]);
      i += 1;
    }
  }
  return { repoRoot, changedFiles: changedFiles.length > 0 ? changedFiles : undefined };
}

function main() {
  const { repoRoot, changedFiles } = parseArgs(process.argv.slice(2));
  const result = checkCapabilityTipsForRepo(repoRoot, { changedFiles });
  if (result.warnings?.length > 0) {
    console.error(`WARN check-capability-tips: ${result.warnings.length} warning(s)`);
    for (const w of result.warnings) {
      console.error(`  - ${w}`);
    }
  }
  if (!result.ok) {
    console.error(`FAIL check-capability-tips: ${result.errors.length} issue(s) found`);
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log('PASS check-capability-tips');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
