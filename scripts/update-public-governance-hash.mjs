#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function usage() {
  return 'Usage: update-public-governance-hash.mjs <public-shared-rules.md> <system-prompt-builder.test.js>';
}

export function computeSharedRulesHeadingsHash(rulesText) {
  const headings = rulesText
    .split('\n')
    .filter((line) => /^###?\s+(P\d|W\d)/.test(line))
    .sort()
    .join('\n');

  if (!headings.trim()) {
    throw new Error('No P*/W* headings found in shared-rules.md');
  }

  return createHash('sha256').update(headings).digest('hex').slice(0, 16);
}

export function replacePinnedGovernanceHash(testContent, hash) {
  const pattern = /const PINNED_HASH = '([0-9a-f]{16}|\$\{PLACEHOLDER\})';/;
  if (!pattern.test(testContent)) {
    throw new Error('PINNED_HASH declaration not found in system-prompt-builder.test.js');
  }
  return testContent.replace(pattern, `const PINNED_HASH = '${hash}';`);
}

export function updatePinnedGovernanceHash(sharedRulesPath, testFilePath) {
  const hash = computeSharedRulesHeadingsHash(readFileSync(sharedRulesPath, 'utf-8'));
  const updated = replacePinnedGovernanceHash(readFileSync(testFilePath, 'utf-8'), hash);
  writeFileSync(testFilePath, updated);
  return hash;
}

export function isCliEntrypoint(metaUrl, argvPath) {
  return argvPath ? realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argvPath)) : false;
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  const [sharedRulesPath, testFilePath] = process.argv.slice(2);
  if (!sharedRulesPath || !testFilePath) {
    console.error(usage());
    process.exit(2);
  }

  try {
    const hash = updatePinnedGovernanceHash(sharedRulesPath, testFilePath);
    console.log(`[public-governance-hash] PINNED_HASH=${hash}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
