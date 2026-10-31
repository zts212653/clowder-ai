import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards on the harness itself (Sol R5): every domain test in this directory must be
// consumed by the canonical check script, and the analyser sources must stay text.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;

function firstControlByte(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < SPACE && code !== TAB && code !== LINE_FEED && code !== CARRIAGE_RETURN) return code;
  }
  return undefined;
}

function designGateSources() {
  const files = readdirSync(here)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => resolve(here, name));
  files.push(resolve(repoRoot, 'scripts/design-gate-real-interaction.mjs'));
  files.push(resolve(repoRoot, 'packages/web/test/browser/default-entry-journey.harness.mjs'));
  return files;
}

describe('design-gate harness guards', () => {
  it('check:design-gate-real-interaction consumes every scripts/design-gate/*.test.mjs', () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    const script = manifest.scripts['check:design-gate-real-interaction'];
    assert.ok(script, 'canonical script missing');
    const testFiles = readdirSync(here).filter((name) => name.endsWith('.test.mjs'));
    assert.ok(testFiles.length > 0);
    const covered = (name) =>
      script.includes('scripts/design-gate/*.test.mjs') || script.includes(`scripts/design-gate/${name}`);
    const missing = testFiles.filter((name) => !covered(name));
    assert.deepEqual(missing, [], `tests not wired into the canonical check script: ${missing.join(', ')}`);
    assert.ok(script.includes('scripts/design-gate-real-interaction.test.mjs'));
  });

  it('analyser and harness sources contain no NUL or other C0 control bytes (git must see text, not binary)', () => {
    for (const file of designGateSources()) {
      const code = firstControlByte(readFileSync(file, 'utf8'));
      assert.equal(code, undefined, `${file} contains control byte 0x${(code ?? 0).toString(16).padStart(2, '0')}`);
    }
  });
});
