/**
 * C02 / K1 / O7 — the saved member config is the identity authority.
 * A dossier self-description fills only what the owner has not edited; once
 * the owner edits role/personality (or roster text) the conflicting dossier
 * block is suppressed for BOTH the member's own identity and every teammate
 * roster, and the suppression is reported. Unedited saves keep the historic
 * dossier projection.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveRoleIdentity } from '@cat-cafe/shared/dossier';
import { bootstrapCatCatalog } from '../dist/config/cat-catalog-store.js';
import { loadResolvedCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import { createRuntimeCat, updateRuntimeCat } from '../dist/config/runtime-cat-catalog.js';

const DOSSIER = {
  l0SelfDescription: 'old dossier persona: architect',
  l0RosterSummary: 'old dossier roster: architecture',
  l0RoutingNote: 'old dossier routing note',
  identity: { pronouns: '她/she', l0PronounReminder: true },
};
const CONFIG = { roleDescription: 'new role: reviewer', personality: 'calm', teamStrengths: 'reviews', caution: null };

describe('resolveRoleIdentity (shared source decision)', () => {
  it('keeps the historic dossier-first projection for an unedited member, with sources', () => {
    const resolved = resolveRoleIdentity(CONFIG, DOSSIER);
    assert.equal(resolved.selfDescription, DOSSIER.l0SelfDescription);
    assert.equal(resolved.selfSource, 'dossier');
    assert.equal(resolved.rosterSummary, DOSSIER.l0RosterSummary);
    assert.equal(resolved.routingNote, DOSSIER.l0RoutingNote);
    assert.equal(resolved.pronouns, '她/she');
    assert.deepEqual(resolved.suppressed, []);
  });

  it('an edited role suppresses the whole dossier self description, nothing else', () => {
    const resolved = resolveRoleIdentity({ ...CONFIG, configuredIdentity: ['role'] }, DOSSIER);
    assert.equal(resolved.selfDescription, undefined);
    assert.equal(resolved.selfSource, 'config');
    assert.equal(resolved.roleDescription, 'new role: reviewer');
    assert.equal(resolved.rosterSummary, DOSSIER.l0RosterSummary, 'roster group was not edited');
    assert.deepEqual(resolved.suppressed, [{ field: 'l0SelfDescription', reason: 'configured_identity' }]);
  });

  it('an edited roster group uses config text for teammates and reports both dossier fields', () => {
    const resolved = resolveRoleIdentity({ ...CONFIG, configuredIdentity: ['roster'] }, DOSSIER);
    assert.equal(resolved.rosterSummary, 'reviews');
    assert.equal(resolved.rosterSummarySource, 'config');
    assert.equal(resolved.routingNote, undefined, 'explicit null caution = no note');
    assert.deepEqual(
      resolved.suppressed.map((segment) => segment.field),
      ['l0RosterSummary', 'l0RoutingNote'],
    );
    assert.equal(resolved.pronouns, '她/she', 'pronouns are a dossier-only supplement');
  });

  it('a member without a dossier uses config throughout', () => {
    const resolved = resolveRoleIdentity({ ...CONFIG, teamStrengths: undefined, caution: 'slow' }, undefined);
    assert.equal(resolved.selfSource, 'config');
    assert.equal(resolved.rosterSummary, 'new role: reviewer', 'teamStrengths → roleDescription fallback kept');
    assert.equal(resolved.routingNote, 'slow');
  });
});

describe('member saves record configured identity only on real changes', () => {
  function fixture(context) {
    const root = mkdtempSync(join(tmpdir(), 'role-identity-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const template = join(root, 'cat-template.json');
    copyFileSync(new URL('../../../cat-template.json', import.meta.url), template);
    bootstrapCatCatalog(root, template);
    const read = (catId) => toAllCatConfigs(loadResolvedCatConfig(template))[catId];
    return { root, read };
  }
  const member = (catId, breedId) => ({
    catId,
    ...(breedId ? { breedId } : {}),
    name: catId,
    displayName: catId,
    avatar: '/avatars/default.png',
    color: { primary: '#765843', secondary: '#eadccc' },
    mentionPatterns: [`@${catId}`],
    roleDescription: 'initial role',
    configurationSource: 'native_tool',
    clientId: 'anthropic',
    carrier: 'cli',
    defaultModel: '',
    mcpSupport: false,
    cli: { command: 'claude', outputFormat: 'stream-json' },
  });

  it('creation and unchanged re-saves do not claim identity authority', async (context) => {
    const { root, read } = fixture(context);
    await createRuntimeCat(root, member('identity-a'));
    assert.equal(read('identity-a').configuredIdentity, undefined);
    await updateRuntimeCat(root, 'identity-a', { roleDescription: 'initial role', avatar: '/avatars/other.png' });
    assert.equal(read('identity-a').configuredIdentity, undefined, 'same role + avatar-only edit');
  });

  it('a role edit marks role; a later caution edit adds roster; survives reload', async (context) => {
    const { root, read } = fixture(context);
    await createRuntimeCat(root, member('identity-b'));
    await updateRuntimeCat(root, 'identity-b', { roleDescription: 'edited role' });
    assert.deepEqual(read('identity-b').configuredIdentity, ['role']);
    await updateRuntimeCat(root, 'identity-b', { caution: 'needs review' });
    assert.deepEqual(read('identity-b').configuredIdentity, ['role', 'roster']);
    assert.equal(read('identity-b').roleDescription, 'edited role');
  });

  it('a variant edit marks only that variant, not breed siblings', async (context) => {
    const { root, read } = fixture(context);
    await createRuntimeCat(root, member('identity-c'));
    await createRuntimeCat(root, member('identity-d', 'identity-c'));
    await updateRuntimeCat(root, 'identity-d', { personality: 'brisk' });
    assert.deepEqual(read('identity-d').configuredIdentity, ['role']);
    assert.equal(read('identity-c').configuredIdentity, undefined);
  });
});

describe('identity marker ignores no-op saves (review P3-5)', () => {
  it('resending unset caution as null or blank teamStrengths does not claim the roster group', async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'role-identity-noop-'));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const template = join(root, 'cat-template.json');
    copyFileSync(new URL('../../../cat-template.json', import.meta.url), template);
    bootstrapCatCatalog(root, template);
    const read = (catId) => toAllCatConfigs(loadResolvedCatConfig(template))[catId];
    await createRuntimeCat(root, {
      catId: 'identity-noop',
      name: 'identity-noop',
      displayName: 'identity-noop',
      avatar: '/avatars/default.png',
      color: { primary: '#765843', secondary: '#eadccc' },
      mentionPatterns: ['@identity-noop'],
      roleDescription: 'initial role',
      configurationSource: 'native_tool',
      clientId: 'anthropic',
      carrier: 'cli',
      defaultModel: '',
      mcpSupport: false,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    assert.equal(read('identity-noop').caution, undefined);
    await updateRuntimeCat(root, 'identity-noop', {
      caution: null,
      teamStrengths: '  ',
      roleDescription: 'initial role',
    });
    assert.equal(read('identity-noop').configuredIdentity, undefined);
  });
});
