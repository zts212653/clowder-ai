import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');

const FORBIDDEN_RUNTIME_DIRECTORIES = [
  'packages/web/src/app/dev/f290-composable-workspace',
  'packages/web/src/components/collective-workspace',
];

const STRUCTURAL_CHECKS = [
  {
    path: 'packages/web/src/lib/workspace-modes.ts',
    pattern: /['"]collective['"]/,
    reason: 'F290 must not register a first-class Workspace mode',
  },
  {
    path: 'packages/web/src/components/WorkspacePanel.tsx',
    pattern: /CollectiveWorkspaceSurface|collective-workspace/,
    reason: 'F290 must not mount a product-owned workbench in WorkspacePanel',
  },
];

const FORBIDDEN_STORAGE_KEYS = ['cat-cafe:f290:collective-workspace', 'cat-cafe:f290-composable-workspace'];

function listSourceFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(path));
    else if (['.ts', '.tsx', '.js', '.mjs'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

export function scanF290WorkbenchBoundary(root = REPO_ROOT) {
  const findings = [];

  for (const path of FORBIDDEN_RUNTIME_DIRECTORIES) {
    if (listSourceFiles(resolve(root, path)).length > 0) {
      findings.push({ path, reason: 'rejected F290 workbench runtime surface still exists' });
    }
  }

  for (const check of STRUCTURAL_CHECKS) {
    const path = resolve(root, check.path);
    if (existsSync(path) && check.pattern.test(readFileSync(path, 'utf8'))) {
      findings.push({ path: check.path, reason: check.reason });
    }
  }

  const webSource = resolve(root, 'packages/web/src');
  for (const path of listSourceFiles(webSource)) {
    const content = readFileSync(path, 'utf8');
    for (const storageKey of FORBIDDEN_STORAGE_KEYS) {
      if (content.includes(storageKey)) {
        findings.push({
          path: relative(root, path),
          reason: `rejected prototype persistence key remains: ${storageKey}`,
        });
      }
    }
  }

  return findings;
}

function main() {
  const findings = scanF290WorkbenchBoundary();
  if (findings.length === 0) {
    console.log('[check:f290-workbench-boundary] PASS');
    return;
  }

  console.error('[check:f290-workbench-boundary] FAIL');
  for (const finding of findings) console.error(`  ${finding.path}: ${finding.reason}`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) main();
