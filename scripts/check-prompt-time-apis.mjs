#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, '..');

const PROMPT_FACING_DIRS = [
  'packages/api/src/domains/cats/services/context',
  'packages/api/src/domains/cats/services/agents/routing',
  'packages/api/src/domains/cats/services/session',
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

const BLOCKED_PATTERNS = [
  {
    name: 'toISOString().slice(11, 16)',
    pattern: /\.toISOString\(\)\.slice\(\s*11\s*,\s*16\s*\)/,
  },
  {
    name: 'toISOString().slice(11)',
    pattern: /\.toISOString\(\)\.slice\(\s*11\b/,
  },
  {
    name: 'getHours()',
    pattern: /\.getHours\(\)/,
  },
  {
    name: 'getMinutes()',
    pattern: /\.getMinutes\(\)/,
  },
  {
    name: 'toLocaleTimeString()',
    pattern: /\.toLocaleTimeString\(/,
  },
];

function* walkFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield fullPath;
    }
  }
}

function scanFile(repoRoot, filePath) {
  const relPath = path.relative(repoRoot, filePath);
  const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/);
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('prompt-time-api-allow')) continue;
    for (const blocked of BLOCKED_PATTERNS) {
      if (blocked.pattern.test(line)) {
        violations.push({
          path: relPath,
          line: i + 1,
          api: blocked.name,
          text: line.trim(),
        });
      }
    }
  }

  return violations;
}

export function checkPromptTimeApisForRepo(repoRoot = defaultRepoRoot, options = {}) {
  const dirs = options.dirs ?? PROMPT_FACING_DIRS;
  const violations = [];

  for (const relDir of dirs) {
    const absDir = path.join(repoRoot, relDir);
    for (const filePath of walkFiles(absDir)) {
      violations.push(...scanFile(repoRoot, filePath));
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

function main() {
  const result = checkPromptTimeApisForRepo(defaultRepoRoot);
  if (result.ok) {
    console.log('No prompt-facing naked time APIs detected.');
    return;
  }

  console.error('Prompt-facing naked time APIs detected.');
  console.error('Use formatPromptTime() or formatPromptTimeRange() so prompt timestamps include date context.');
  console.error('');
  for (const violation of result.violations) {
    console.error(`  ${violation.path}:${violation.line} ${violation.api}`);
    console.error(`    ${violation.text}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
