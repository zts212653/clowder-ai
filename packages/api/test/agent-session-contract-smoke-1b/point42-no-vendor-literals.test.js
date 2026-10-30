// #1647 slice 1b — agreement v1.4 §42 (with §43 moving the adapter): the
// contract stays vendor-neutral.
//
// The whole point of the slice is that a provider is described by a declaration,
// not by a hard-coded name. A literal `provider === '...'` / `clientId === '...'`
// / `carrier === '...'` comparison in the new directory would quietly
// reintroduce the coupling this work removes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const AGENTS_ROOT = fileURLToPath(new URL('../../src/domains/cats/services/agents/', import.meta.url));
const CONTRACT_DIR = path.join(AGENTS_ROOT, 'session-contract');
const ACP_ADAPTER = path.join(CONTRACT_DIR, 'acp-session-provider.ts');

const LITERAL_COMPARISON =
  /\b(?:provider|clientId|carrier)\s*(?:===|!==|==|!=)\s*['"`]|['"`]\s*(?:===|!==|==|!=)\s*(?:provider|clientId|carrier)\b/;

function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('[42] the new session-contract sources avoid vendor literal comparisons', () => {
  assert.ok(fs.existsSync(CONTRACT_DIR), `missing source directory: ${CONTRACT_DIR}`);
  assert.ok(fs.existsSync(ACP_ADAPTER), `missing adapter: ${ACP_ADAPTER}`);

  const files = collectFiles(CONTRACT_DIR);
  assert.ok(files.includes(ACP_ADAPTER), 'the ACP adapter must live in session-contract/ and be scanned');
  assert.ok(files.length >= 2);

  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (LITERAL_COMPARISON.test(line)) {
        offenders.push(`${path.relative(AGENTS_ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(offenders, [], `vendor literal comparison(s) found:\n${offenders.join('\n')}`);
});
