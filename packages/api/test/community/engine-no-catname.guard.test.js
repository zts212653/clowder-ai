/**
 * F168 Phase C — C1.3: engine-zero-catname hard-layer guard (INV-6, ADR-031 硬层).
 *
 * INV-6: the community-ops ENGINE routes by role, never by cat name. Engine code in
 * packages/api/src/domains/community/ must NOT:
 *   (A) import getRoster (pull the roster singleton) — it gets a RoleResolver injected instead;
 *   (B) hardcode a known cat id — role→cat binding lives ONLY in the RoleResolver binding layer.
 *
 * Documented carve-outs:
 *   - RoleResolver.ts is the binding layer — the ONE place cat ids legitimately live (rule B).
 *   - GuardianMatcher.ts consumes getRoster for family-based review-guardian matching (a roster
 *     algorithm, NOT role→executor routing) and hardcodes no cat names. Pre-existing; Phase D
 *     convergence tracked (plan OQ-C1a). Allowlisted for rule A only.
 *
 * This is a source-level regression guard (cf. bootstrap-wiring-guard): it locks the current clean
 * state and fails CI the moment new engine code pulls getRoster or hardcodes a cat id.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const COMMUNITY_DIR = fileURLToPath(new URL('../../src/domains/community/', import.meta.url));
const CAT_TEMPLATE_PATH = fileURLToPath(new URL('../../../../cat-template.json', import.meta.url));
const { loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');

/** Rule B carve-out: the binding layer is where cat ids are allowed to live. */
const CATNAME_ALLOWLIST = new Set(['RoleResolver.ts']);

/** Rule A carve-out: RoleResolver receives getRoster injected (never imports it); GuardianMatcher
 *  is a legitimate roster consumer pending Phase D convergence (OQ-C1a). */
const GETROSTER_ALLOWLIST = new Set(['GuardianMatcher.ts']);

/** Known cat ids that must never be hardcoded in engine code (INV-6 零猫名). */
const KNOWN_CAT_IDS = Object.keys(toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH))).sort();

// Recursive so the guard keeps covering engine code even if it is later split into subdirectories
// (gpt52 review note 2026-06-13 — relying on a future dev "remembering" to widen scope is the
// false-security failure mode hard guards exist to prevent). readdirSync(recursive) returns paths
// relative to COMMUNITY_DIR; allowlists are matched by basename(f) below.
const communityFiles = () =>
  readdirSync(COMMUNITY_DIR, { recursive: true })
    .map((f) => String(f))
    .filter((f) => f.endsWith('.ts'));
const read = (relPath) => readFileSync(COMMUNITY_DIR + relPath, 'utf-8');

/**
 * INV-6 rule A detector: does this engine source pull the roster singleton, by ANY import shape?
 * A narrow literal-`getRoster`-token scan (the original) missed namespace imports
 * (`import * as cc from '../../config/cat-config-loader.js'` + `cc.getRoster()`) — exactly the
 * false-security failure mode hard guards exist to prevent (codex cloud review 2026-06-13 #3408532238).
 */
const enginePullsRoster = (src) => {
  // (1) any import whose module specifier is the cat-config-loader — covers namespace / default /
  //     named alike, closing the bypass a literal-token scan missed.
  if (/\bimport\b[^;]*?from\s*['"][^'"]*cat-config-loader[^'"]*['"]/.test(src)) return true;
  // (2) a getRoster token on an import line — covers re-export barrels that rename the path.
  if (/\bimport\b[^;]*\bgetRoster\b/.test(src)) return true;
  // (3) a getRoster member access (cc.getRoster()) — covers a namespace import of a barrel that
  //     re-exports getRoster, where neither import-line check above sees it.
  if (/\.\s*getRoster\b/.test(src)) return true;
  return false;
};

describe('F168 Phase C C1.3: engine-zero-catname guard (INV-6)', () => {
  it('scans the community domain (guard is not vacuous)', () => {
    assert.ok(communityFiles().length > 5, `expected several community files, got ${communityFiles().length}`);
  });

  it('rule A — no engine file pulls the roster singleton (engine routes via injected RoleResolver)', () => {
    const offenders = [];
    for (const f of communityFiles()) {
      if (GETROSTER_ALLOWLIST.has(basename(f))) continue;
      if (enginePullsRoster(read(f))) offenders.push(f);
    }
    assert.deepEqual(
      offenders,
      [],
      `INV-6: engine code must NOT pull getRoster / cat-config-loader — inject a RoleResolver instead. Offenders: ${offenders.join(', ')}`,
    );
  });

  // The detector itself, exercised on synthetic sources — locks the import shapes it must catch so a
  // future narrowing can't silently reopen the namespace bypass (codex cloud review #3408532238).
  describe('rule A detector (enginePullsRoster) — covers all import shapes, not just literal token', () => {
    it('flags the original named import (no regression)', () => {
      assert.equal(enginePullsRoster(`import { getRoster } from '../../config/cat-config-loader.js';`), true);
    });
    it('flags namespace import of cat-config-loader + member access (the reported bypass)', () => {
      assert.equal(
        enginePullsRoster(
          `import * as catConfig from '../../config/cat-config-loader.js';\nconst r = catConfig.getRoster();`,
        ),
        true,
      );
    });
    it('flags any import from cat-config-loader regardless of what it pulls', () => {
      assert.equal(enginePullsRoster(`import { getDefaultCatId } from '../../config/cat-config-loader.js';`), true);
    });
    it('flags a getRoster member access from a re-export barrel (neither import-line check sees it)', () => {
      assert.equal(enginePullsRoster(`import * as helpers from './helpers.js';\nhelpers.getRoster();`), true);
    });
    it('does NOT flag unrelated imports / prose mentioning getRoster (no false positive)', () => {
      assert.equal(enginePullsRoster(`import { foo } from './bar.js';\nconst x = foo();`), false);
      assert.equal(enginePullsRoster(`// a comment mentioning getRoster in prose`), false);
    });
  });

  it('rule B — no engine file hardcodes a known cat id (bind via RoleResolver)', () => {
    const offenders = [];
    for (const f of communityFiles()) {
      if (CATNAME_ALLOWLIST.has(basename(f))) continue;
      const src = read(f);
      for (const catId of KNOWN_CAT_IDS) {
        if (new RegExp(`['"\\\`]${catId}['"\\\`]`).test(src)) offenders.push(`${f}:${catId}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `INV-6: engine code must NOT hardcode cat ids — role→cat binding lives in RoleResolver. Offenders: ${offenders.join(', ')}`,
    );
  });

  it('the binding layer (RoleResolver.ts) DOES hold the cat id — proves rule B scan is live', () => {
    assert.ok(
      /['"]gemini25['"]/.test(read('RoleResolver.ts')),
      'RoleResolver should hold the narrator binding catId; if it moved, update this guard',
    );
  });

  // R2-1 (codex cloud review #3409253420): rule B's cat-id set must be DERIVED from the catalog,
  // not a hand-maintained list that drifts. Asserts the derived set covers catalog ids a stale
  // manual list missed (fable-5/antig-opus/dare/opencode/kimi were all absent before).
  it('rule B cat-id set is derived from the catalog (no manual drift)', () => {
    assert.ok(KNOWN_CAT_IDS.length >= 10, `expected a populated derived cat-id set, got ${KNOWN_CAT_IDS.length}`);
    for (const id of ['fable-5', 'antig-opus', 'dare', 'opencode', 'kimi', 'gemini25', 'sonnet']) {
      assert.ok(
        KNOWN_CAT_IDS.includes(id),
        `derived cat-id set must include catalog id '${id}' (drift would silently un-guard it)`,
      );
    }
  });

  // R2-2 (codex cloud review #3409253421): RoleResolver must NOT be rule-A allowlisted — it receives
  // getRoster injected and must never import it, so rule A should actively guard it. Allowlisting it
  // would skip the scan and leave the binding layer's INV-6 regression unprotected.
  it('rule A actively guards RoleResolver.ts (not allowlisted) — binding layer stays injection-only', () => {
    assert.ok(
      !GETROSTER_ALLOWLIST.has('RoleResolver.ts'),
      'RoleResolver must NOT be in rule-A allowlist (only GuardianMatcher needs it)',
    );
    assert.equal(
      enginePullsRoster(read('RoleResolver.ts')),
      false,
      'RoleResolver.ts must not pull the roster (injection-only); if this regresses, rule A now catches it',
    );
  });
});
