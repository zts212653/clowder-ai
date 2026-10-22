import '../packages/api/test/helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveL0Projections } from '@cat-cafe/shared';
import { buildTeammateRoster } from '../packages/api/dist/domains/cats/services/context/SystemPromptBuilder.js';
import { writeDossierFixture } from '../packages/api/test/helpers/dossier-fixture.js';
import { compileL0 } from './compile-system-prompt-l0.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dossier-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profileDir = join(root, 'profile');
  mkdirSync(profileDir);
  writeDossierFixture(root);
  return { root, profileDir };
}

test('API roster consumes pronoun and summary from the explicit dossier root', (t) => {
  const { root } = fixture(t);
  const roster = buildTeammateRoster('codex', root);
  assert.match(roster, /（戊）/);
  assert.match(roster, /fixture-roster-canary/);
  assert.doesNotMatch(buildTeammateRoster('codex', join(root, 'absent')), /fixture-roster-canary|（戊）/);
});

test('compiled roster consumes the explicit pronoun and routing note, excluding the capability summary', async (t) => {
  const { root: dossierRoot, profileDir } = fixture(t);
  const l0 = await compileL0({ catId: 'codex', dossierRoot, profileDir });
  assert.match(l0, /（戊）/);
  assert.match(l0, /fixture-route-canary/);
  assert.doesNotMatch(l0, /fixture-roster-canary/);
});

test('compiled identity consumes self description and preserves absent-dossier fallback', async (t) => {
  const { root: dossierRoot, profileDir } = fixture(t);
  const l0 = await compileL0({ catId: 'fable-5', dossierRoot, profileDir });
  assert.match(l0, /角色与自我校准：fixture-self-canary/);
  const absent = await compileL0({ catId: 'fable-5', dossierRoot: join(dossierRoot, 'absent'), profileDir });
  assert.doesNotMatch(absent, /fixture-self-canary/);
  assert.match(absent, /角色：/);
});

test('public participation ignores the owner dossier even when explicitly supplied', async (t) => {
  const { root: dossierRoot, profileDir } = fixture(t);
  const l0 = await compileL0({ catId: 'fable-5', dossierRoot, profileDir, projection: 'public' });
  assert.doesNotMatch(l0, /fixture-|（戊）|队友名册/);
  assert.match(l0, /Identity constant: `@fable-5`/);
});

test('compiler enforces edition projection support without losing owner dossier behavior', async (t) => {
  const { root: dossierRoot, profileDir } = fixture(t);
  const options = { catId: 'fable-5', dossierRoot, profileDir, projection: 'collective-work' };
  if (resolveL0Projections().includes('collective-work')) {
    const work = await compileL0(options);
    assert.match(work, /fixture-self-canary/);
    assert.match(work, /队友名册/);
  } else {
    await assert.rejects(compileL0(options), /unsupported projection/);
    const owner = await compileL0({ ...options, projection: 'owner' });
    assert.match(owner, /fixture-self-canary/);
  }
  await assert.rejects(compileL0({ ...options, projection: 'unknown' }), /unsupported projection/);
});
