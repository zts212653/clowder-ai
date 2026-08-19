/**
 * F208 R2 regression tests for load-dossier-profiles.ts
 *
 * Pins the two R2 behavior changes:
 *   R2-P1: ENOENT (community) vs non-ENOENT (drift) error classification
 *   R2-P2: hasDossierEntry scoping (runtime/custom cats don't false-positive)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  _resetDossierCache,
  getDossierL0Pronouns,
  getDossierL0RoutingNote,
  getDossierL0SelfDescription,
  getDossierRosterSummary,
  hasDossierEntry,
  isDossierAvailable,
  loadDossierProfiles,
} from '../dossier/load-dossier-profiles.js';

const MINIMAL_DOSSIER = `
# Cat Dossier

## opus

\`\`\`yaml
# structured-profile: cat:opus
entityId: "cat:opus"
identity:
  pronouns: "他/he"  # operator-confirmed identity fact
  l0PronounReminder: true  # repeated correction; hydrate into the scarce roster
oneLiner: "Main architect"
l0RosterSummary: "Architecture and deep thinking"
l0RoutingNote: "Architecture decisions only"
l0SelfDescription: "Architect; state the stopping condition before deep research"
\`\`\`

## sonnet

\`\`\`yaml
# structured-profile: cat:sonnet
entityId: "cat:sonnet"
identity:
  pronouns: "她/she"
oneLiner: "Fast and flexible"
l0RosterSummary: "Quick and versatile coding"
\`\`\`
`;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

afterEach(() => {
  _resetDossierCache();
});

describe('R2-P1: ENOENT vs non-ENOENT error classification', () => {
  test('ENOENT (no dossier file) → community mode: isDossierAvailable = false, no warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const profiles = loadDossierProfiles('/nonexistent/path');
      expect(profiles.size).toBe(0);
      expect(isDossierAvailable('/nonexistent/path')).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('non-ENOENT error (EISDIR) → drift signal: isDossierAvailable = true, KD-9 warning emitted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tempRoot = mkdtempSync(join(tmpdir(), 'dossier-r2p1-'));
    const dossierDir = join(tempRoot, 'docs', 'team');
    mkdirSync(dossierDir, { recursive: true });
    // Make cat-dossier.md a directory instead of a file → readFileSync throws EISDIR
    mkdirSync(join(dossierDir, 'cat-dossier.md'));

    try {
      const profiles = loadDossierProfiles(tempRoot);
      expect(profiles.size).toBe(0);
      expect(isDossierAvailable(tempRoot)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[F208 KD-9]'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      warnSpy.mockRestore();
    }
  });
});

describe('R2-P2: hasDossierEntry warning scope', () => {
  test('canonical Fable engagement policy survives the typed loader', () => {
    const policy = loadDossierProfiles(REPO_ROOT).get('fable-5')?.engagementPolicy;

    expect(policy?.defaultMode).toBe('one_shot_calibration');
    expect(policy?.reentry).toBe('only_for_new_architecture_or_decision_judgment_or_explicit_cvo_request');
  });

  test('hydrates identity.pronouns from the structured dossier profile', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dossier-pronouns-'));
    const dossierDir = join(tempRoot, 'docs', 'team');
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'cat-dossier.md'), MINIMAL_DOSSIER);

    try {
      const profiles = loadDossierProfiles(tempRoot);
      expect(profiles.get('opus')?.identity?.pronouns).toBe('他/he');
      expect(getDossierL0Pronouns('opus', tempRoot)).toBe('他/he');
      expect(profiles.get('sonnet')?.identity?.pronouns).toBe('她/she');
      expect(getDossierL0Pronouns('sonnet', tempRoot)).toBeUndefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('hydrates the compact L0 routing note independently from the capability summary', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dossier-routing-note-'));
    const dossierDir = join(tempRoot, 'docs', 'team');
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'cat-dossier.md'), MINIMAL_DOSSIER);

    try {
      expect(getDossierL0RoutingNote('opus', tempRoot)).toBe('Architecture decisions only');
      expect(getDossierL0RoutingNote('sonnet', tempRoot)).toBeUndefined();
      expect(getDossierRosterSummary('opus', tempRoot)).toBe('Architecture and deep thinking');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('hydrates the self-facing persona projection independently from teammate diagnosis', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dossier-self-description-'));
    const dossierDir = join(tempRoot, 'docs', 'team');
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'cat-dossier.md'), MINIMAL_DOSSIER);

    try {
      expect(getDossierL0SelfDescription('opus', tempRoot)).toBe(
        'Architect; state the stopping condition before deep research',
      );
      expect(getDossierL0SelfDescription('sonnet', tempRoot)).toBeUndefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('tracked cat with dossier entry → hasDossierEntry = true', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dossier-r2p2-'));
    const dossierDir = join(tempRoot, 'docs', 'team');
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'cat-dossier.md'), MINIMAL_DOSSIER);

    try {
      // Parser keys by the catId after "cat:" in the marker
      expect(hasDossierEntry('opus', tempRoot)).toBe(true);
      expect(hasDossierEntry('sonnet', tempRoot)).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('runtime/custom cat with no dossier entry → hasDossierEntry = false', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dossier-r2p2-'));
    const dossierDir = join(tempRoot, 'docs', 'team');
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(join(dossierDir, 'cat-dossier.md'), MINIMAL_DOSSIER);

    try {
      // runtime-spark has no dossier entry → predicates return false/undefined
      expect(getDossierRosterSummary('runtime-spark', tempRoot)).toBeUndefined();
      expect(hasDossierEntry('runtime-spark', tempRoot)).toBe(false);
      // Consumer-level no-false-positive test is in system-prompt-builder.test.js
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('tracked cat with entry but missing l0RosterSummary → drift detectable', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dossier-r2p2-'));
    const dossierDir = join(tempRoot, 'docs', 'team');
    mkdirSync(dossierDir, { recursive: true });
    writeFileSync(
      join(dossierDir, 'cat-dossier.md'),
      [
        '# Cat Dossier',
        '',
        '## drift-cat',
        '',
        '```yaml',
        '# structured-profile: cat:drift-cat',
        'entityId: "cat:drift-cat"',
        'oneLiner: "Cat with incomplete profile"',
        '```',
      ].join('\n'),
    );

    try {
      // drift-cat has entry but no l0RosterSummary
      expect(getDossierRosterSummary('drift-cat', tempRoot)).toBeUndefined();
      expect(hasDossierEntry('drift-cat', tempRoot)).toBe(true);
      // Consumer would fire warning: !summary && hasDossierEntry → true
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('community mode (no dossier) → hasDossierEntry = false for any cat', () => {
    expect(hasDossierEntry('opus', '/nonexistent/path')).toBe(false);
    expect(hasDossierEntry('runtime-spark', '/nonexistent/path')).toBe(false);
  });
});
