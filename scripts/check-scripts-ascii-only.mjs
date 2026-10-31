#!/usr/bin/env node

/**
 * Lint guard for service install/server/uninstall scripts.
 *
 * Two real production bug patterns hit during PR #674, both rooted in
 * non-ASCII content in shell/PowerShell scripts:
 *
 * 1. **bash `set -u` + Chinese punctuation adjacent to $var**:
 *    `echo "  ... $myvar（chinese paren ...）"` — bash variable-name lexing
 *    extends the identifier into the UTF-8 lead bytes of full-width
 *    punctuation, treats it as an unknown var, aborts.
 *      prereq-check.sh: line 372: sys_proxy_candidate�: unbound variable
 *
 * 2. **Windows PowerShell 5.1 mis-decoding UTF-8-no-BOM**:
 *    .ps1 files containing Chinese strings get parsed with the legacy
 *    Windows-1252 decoder by PS 5.1 (which ships with every Windows
 *    install). Multi-byte UTF-8 sequences become several Windows-1252
 *    chars; some happen to be quote terminators, causing:
 *      Unexpected token 'Pre-downloading' in expression or statement.
 *      The string is missing the terminator: ".
 *
 * After the second incident, user instruction was simple: drop all
 * Chinese from scripts and stay pure ASCII. This guard enforces it.
 *
 * Comments included: a Chinese comment that's harmless today still
 * compiles to a multi-byte sequence on disk that could trip future
 * tooling (clipboard paste into Notepad ANSI, log scrapers expecting
 * ASCII, etc.). Pure-ASCII is the simpler invariant.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS_DIR = 'scripts/services';

let failures = 0;
for (const f of readdirSync(SCRIPTS_DIR)) {
  if (!f.endsWith('.ps1') && !f.endsWith('.sh')) continue;
  const path = join(SCRIPTS_DIR, f);
  const buf = readFileSync(path);
  const offenders = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 0x80) {
      offenders.push(i);
      if (offenders.length >= 5) break;
    }
  }
  if (offenders.length > 0) {
    // Map byte offsets to (line, col) for actionable error messages.
    const lines = buf.toString('utf8').split('\n');
    const points = offenders.map((byteIdx) => {
      let count = 0;
      for (let ln = 0; ln < lines.length; ln++) {
        const lineBytes = Buffer.byteLength(lines[ln] + '\n', 'utf8');
        if (count + lineBytes > byteIdx) {
          return `line ${ln + 1}`;
        }
        count += lineBytes;
      }
      return `byte ${byteIdx}`;
    });
    console.error(
      `✗ ${path}: contains non-ASCII bytes at ${points.join(', ')}${offenders.length >= 5 ? ' (+more)' : ''}`,
    );
    failures += 1;
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} script(s) contain non-ASCII characters. scripts/services/*.{sh,ps1} must be pure ASCII to avoid bash set -u multi-byte unbound and PowerShell 5.1 UTF-8 mis-decoding bugs (see history: PR #674, F167 Case E6).`,
  );
  process.exit(1);
}
console.log('✅ All scripts/services/*.{sh,ps1} are pure ASCII.');
