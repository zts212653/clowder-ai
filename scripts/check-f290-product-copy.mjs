#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const PRODUCT_DIRECTORY = resolve(REPO_ROOT, 'packages/web/src/app/dev/f290-asset-collaboration');

const FORBIDDEN_TERMS = ['镜片', 'canonical', '判断门', 'inspector', 'gate', 'endpoint', '望窗', 'lineage', '轨迹层'];
const SCANNED_EXTENSIONS = new Set(['.json', '.ts', '.tsx']);

export function findForbiddenProductTerms(text) {
  const normalized = text.toLocaleLowerCase();
  return FORBIDDEN_TERMS.filter((term) => normalized.includes(term.toLocaleLowerCase())).map((term) =>
    term.toLocaleLowerCase(),
  );
}

function listProductFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '__tests__') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listProductFiles(path));
    else if (SCANNED_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

export function scanF290ProductCopy(root = REPO_ROOT) {
  const productDirectory = resolve(root, relative(REPO_ROOT, PRODUCT_DIRECTORY));
  const findings = [];
  for (const path of listProductFiles(productDirectory)) {
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
    console.log('[check:f290-product-copy] PASS — no internal vocabulary in the asset experience');
    return;
  }

  console.error('[check:f290-product-copy] FAIL — replace internal vocabulary with user-facing language');
  for (const finding of findings) console.error(`  ${finding.path}:${finding.line} ${finding.term}`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) main();
