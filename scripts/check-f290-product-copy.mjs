#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const PRODUCT_PATHS = [
  'packages/collective-client/src',
  'packages/web/src/components/collective',
  'packages/web/src/components/settings/OfficialPluginCard.tsx',
  'packages/api/src/domains/plugin/official-catalog.ts',
  'packages/web/src/app/dev/f290-asset-collaboration',
];

const FORBIDDEN_TERMS = [
  '镜片',
  '判断门',
  'inspector',
  '望窗',
  '轨迹层',
  'canonical client',
  'canonical order',
  'service truth',
  'backed by the service event log',
  'ack #',
];
const SCANNED_EXTENSIONS = new Set(['.json', '.ts', '.tsx']);

export function findForbiddenProductTerms(text) {
  const normalized = text.toLocaleLowerCase();
  return FORBIDDEN_TERMS.filter((term) => normalized.includes(term.toLocaleLowerCase())).map((term) =>
    term.toLocaleLowerCase(),
  );
}

function listProductFiles(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return SCANNED_EXTENSIONS.has(extname(path)) ? [path] : [];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...listProductFiles(child));
    else if (SCANNED_EXTENSIONS.has(extname(entry.name))) files.push(child);
  }
  return files;
}

export function scanF290ProductCopy(root = REPO_ROOT) {
  const findings = [];
  const files = PRODUCT_PATHS.flatMap((path) => listProductFiles(resolve(root, path)));
  for (const path of files) {
    const content = readFileSync(path, 'utf8');
    for (const [lineIndex, line] of content.split('\n').entries()) {
      for (const term of findForbiddenProductTerms(line)) {
        findings.push({ path: relative(root, path), line: lineIndex + 1, term });
      }
    }
  }
  return findings;
}

function main() {
  const findings = scanF290ProductCopy();
  if (findings.length === 0) {
    console.log('[check:f290-product-copy] PASS — production Collective surfaces use product language');
    return;
  }

  console.error('[check:f290-product-copy] FAIL — replace internal vocabulary with user-facing language');
  for (const finding of findings) console.error(`  ${finding.path}:${finding.line} ${finding.term}`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) main();
