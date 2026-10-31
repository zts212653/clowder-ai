import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createIsolatedTemplateRoot } from './helpers/isolated-template-root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_TEMPLATE = resolve(__dirname, '../../../cat-template.json');

// F211 #2013 follow-up: the catalog test-isolation flake. The API boot path writes an
// empty (breeds:[]) .cat-cafe/cat-catalog.json into dirname(CAT_TEMPLATE_PATH); when the
// per-process temp root was named by pid, OS pid reuse leaked that stale catalog into a
// later test, collapsing getRoster() to owner-only (guardian-matcher / community-issues
// guardian routes flaked candidates=0 under the concurrent suite). These lock the fix:
// a genuinely unique root per call, no .cat-cafe overlay, no pid-reuse inheritance.
describe('createIsolatedTemplateRoot (catalog test isolation)', () => {
  test('returns a distinct root each call (no pid-reuse collision)', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'iso-base-'));
    try {
      const a = createIsolatedTemplateRoot(base, REAL_TEMPLATE);
      const b = createIsolatedTemplateRoot(base, REAL_TEMPLATE);
      assert.notEqual(a.root, b.root, 'two calls must yield distinct roots');
      assert.ok(existsSync(a.templatePath), 'first template copy exists');
      assert.ok(existsSync(b.templatePath), 'second template copy exists');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('the root carries the template but NO .cat-cafe overlay', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'iso-base-'));
    try {
      const { templatePath, root } = createIsolatedTemplateRoot(base, REAL_TEMPLATE);
      assert.ok(existsSync(templatePath), 'cat-template.json copied');
      assert.equal(
        existsSync(resolve(root, '.cat-cafe', 'cat-catalog.json')),
        false,
        'fresh root must have no catalog overlay (loadCatConfig falls back to full template)',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('does NOT inherit a stale breeds:[] catalog from a pid-named sibling (flake regression)', () => {
    const base = mkdtempSync(resolve(tmpdir(), 'iso-base-'));
    try {
      // Reproduce the exact leftover the old `cat-cafe-test-template-${pid}` scheme would
      // recycle: a prior process's app boot wrote an empty (breeds:[]) catalog here.
      const stalePid = 999_999;
      const staleRoot = resolve(base, `cat-cafe-test-template-${stalePid}`);
      mkdirSync(resolve(staleRoot, '.cat-cafe'), { recursive: true });
      const tpl = JSON.parse(readFileSync(REAL_TEMPLATE, 'utf-8'));
      writeFileSync(
        resolve(staleRoot, '.cat-cafe', 'cat-catalog.json'),
        JSON.stringify({
          ...tpl,
          breeds: [],
          roster: { owner: { family: 'owner', roles: ['owner'], lead: false, available: true, evaluation: 'x' } },
        }),
      );
      // The fixed (mkdtemp) scheme must NOT reuse the stale pid-named root, and the fresh
      // root must be clean — so getRoster() reads the full template, not breeds:[].
      const { root, templatePath } = createIsolatedTemplateRoot(base, REAL_TEMPLATE);
      assert.notEqual(root, staleRoot, 'fresh root must differ from the stale pid-named root');
      assert.ok(existsSync(templatePath), 'fresh template copied');
      assert.equal(
        existsSync(resolve(root, '.cat-cafe', 'cat-catalog.json')),
        false,
        'fresh root must not inherit the stale breeds:[] catalog',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
