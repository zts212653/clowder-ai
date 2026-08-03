import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CANONICAL_PARSER = 'packages/api/src/infrastructure/harness-eval/friction/paw-feel-marker.ts';
const DISPOSITION_API_ROOT = 'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/';
const READ_MODEL = 'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/read-model.ts';
const SERVICE = 'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/service.ts';
const EVENT_LOG = 'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/event-log.ts';
const COMPOSITION_ROOT = 'packages/api/src/index.ts';
const SHARED_CONTRACT = 'packages/shared/src/types/paw-feel-disposition.ts';

const STORED_CONTRACT_FILES = new Set([
  SHARED_CONTRACT,
  'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/schema.ts',
  EVENT_LOG,
  'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/projector.ts',
  SERVICE,
  'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/coverage-store.ts',
  'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/duty-config-store.ts',
]);

const FORBIDDEN_BODY_FIELD = /\b(?:markerBody|rawMarker|markerText|symptom|phenomenon|body)\??\s*:/i;
const PAW_FEEL_REGEX = /\/(?:[^/\n\\]|\\.)*(?:爪感差|\\u722a\\u611f\\u5dee)(?:[^/\n\\]|\\.)*\/[dgimsuvy]*/i;
const DIRECT_APPEND = /\b(?:eventLog|dispositionEventLog|this\.options\.eventLog)\.append\s*\(/;
const SECOND_COMPOSITION = /\bnew\s+RedisPawFeelDispositionEventLog\s*\(/;
const BROWSER_PERSISTENCE = /\b(?:localStorage|sessionStorage|indexedDB)\b/;

function normalizePath(path) {
  return path.split(sep).join('/');
}

function functionBody(source, name) {
  const declaration = new RegExp(`\\b(?:function\\s+|private\\s+(?:async\\s+)?)${name}\\s*\\(`).exec(source);
  if (!declaration) return '';
  const opening = source.indexOf('{', declaration.index);
  if (opening < 0) return '';
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(opening + 1, index);
    }
  }
  return source.slice(opening + 1);
}

function isPawFeelWebFile(path) {
  return (
    path.startsWith('packages/web/src/') &&
    !path.includes('/__tests__/') &&
    (path.includes('/paw-feel/') || /\/PawFeel[^/]*\.(?:ts|tsx)$/.test(path))
  );
}

function violation(path, rule, message) {
  return { path, rule, message };
}

function isParserSurface(path) {
  return (
    path === CANONICAL_PARSER ||
    path.startsWith(DISPOSITION_API_ROOT) ||
    path.endsWith('/friction/paw-feel-source.ts') ||
    path.endsWith('/friction/paw-feel-adapter.ts')
  );
}

function semanticVisibilityIsGated(source) {
  const filtering = functionBody(source, 'filterAndSort');
  const conditionalHide =
    /\bif\s*\([^)]*(?:degraded|semantic)[^)]*\)\s*(?:return\s*\[\]|\{[\s\S]{0,240}?(?:return\s*\[\]|items\s*:\s*\[\]|\.filter\s*\())/i.test(
      source,
    ) || /(?:degraded|semantic)[^?\n]*\?\s*\[\]\s*:/i.test(source);
  return /(?:degraded|semantic)/i.test(filtering) || conditionalHide;
}

function analyzeFile(path, source) {
  const violations = [];
  if (STORED_CONTRACT_FILES.has(path) && FORBIDDEN_BODY_FIELD.test(source)) {
    violations.push(
      violation(
        path,
        'source-ref-only',
        'persisted marker body field detected; F278 storage may contain only source refs, digest, and disposition',
      ),
    );
  }
  if (isParserSurface(path) && path !== CANONICAL_PARSER && PAW_FEEL_REGEX.test(source)) {
    violations.push(violation(path, 'single-parser', `second parser detected; reuse ${CANONICAL_PARSER}`));
  }
  if (path.startsWith(DISPOSITION_API_ROOT) && path !== SERVICE && path !== EVENT_LOG && DIRECT_APPEND.test(source)) {
    violations.push(
      violation(path, 'single-writer', `direct disposition writer path detected; route commands through ${SERVICE}`),
    );
  }
  if (path !== COMPOSITION_ROOT && SECOND_COMPOSITION.test(source)) {
    violations.push(
      violation(
        path,
        'single-composition-root',
        `second Redis event-log composition root detected; instantiate only in ${COMPOSITION_ROOT}`,
      ),
    );
  }
  if (path === READ_MODEL && semanticVisibilityIsGated(source)) {
    violations.push(
      violation(
        path,
        'semantic-not-a-gate',
        'semantic/degraded state is used as a visibility gate; it may affect suggestions only',
      ),
    );
  }
  if (isPawFeelWebFile(path) && BROWSER_PERSISTENCE.test(source)) {
    violations.push(
      violation(
        path,
        'single-ledger',
        'browser persistence detected; Workspace, Settings, and source bubbles must project the canonical ledger',
      ),
    );
  }
  return violations;
}

export function analyzePawFeelDispositionBoundaries(files) {
  return [...files].flatMap(([rawPath, source]) => analyzeFile(normalizePath(rawPath), source));
}

async function collectFiles(root, directory) {
  const absolute = join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = new Map();
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(root, relative(root, child));
      for (const item of nested) files.set(...item);
    } else if (['.ts', '.tsx'].includes(extname(entry.name)) && !child.includes(`${sep}__tests__${sep}`)) {
      files.set(normalizePath(relative(root, child)), await readFile(child, 'utf8'));
    }
  }
  return files;
}

export async function readPawFeelDispositionBoundarySources(root) {
  const files = new Map();
  for (const directory of [
    'packages/api/src/infrastructure/harness-eval/friction',
    'packages/api/src/infrastructure/harness-eval/paw-feel-disposition',
    'packages/api/src/routes',
    'packages/mcp-server/src/tools',
    'packages/web/src/components',
  ]) {
    const nested = await collectFiles(root, directory);
    for (const [path, source] of nested) {
      const relevant =
        path === CANONICAL_PARSER ||
        path.includes('/paw-feel-') ||
        path.includes('/paw-feel/') ||
        /\/PawFeel[^/]*\.(?:ts|tsx)$/.test(path);
      if (relevant) files.set(path, source);
    }
  }
  for (const path of [COMPOSITION_ROOT, SHARED_CONTRACT]) {
    files.set(path, await readFile(join(root, path), 'utf8'));
  }
  return files;
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = await readPawFeelDispositionBoundarySources(root);
  const violations = analyzePawFeelDispositionBoundaries(files);
  if (violations.length > 0) {
    console.error('F278 paw-feel disposition boundary check FAILED:');
    for (const entry of violations) console.error(`- [${entry.rule}] ${entry.path}: ${entry.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`F278 paw-feel disposition boundary check PASS (${files.size} production files)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
