import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';

const { preflightAgyProfile, resolveAgyProfile } = await import(
  '../dist/domains/cats/services/agents/providers/agy-profile-manager.js'
);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('agy-profile-manager', () => {
  test('creates isolated per-cat HOME settings with expected model and trusted workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-profile-root-'));
    const worktree = mkdtempSync(join(tmpdir(), 'agy-profile-worktree-'));

    try {
      const flash = resolveAgyProfile({
        catId: 'gemini35',
        expectedModel: 'Gemini 3.5 Flash (High)',
        workingDirectory: worktree,
        config: { enabled: true, homeRoot: root, model: 'Gemini 3.5 Flash (High)' },
      });
      const pro = resolveAgyProfile({
        catId: 'gemini31',
        expectedModel: 'Gemini 3.1 Pro (High)',
        workingDirectory: worktree,
        config: { enabled: true, homeRoot: root, model: 'Gemini 3.1 Pro (High)' },
      });

      assert.notEqual(flash.homePath, pro.homePath, 'profiles for different cats must not share HOME');
      assert.ok(flash.homePath.startsWith(root), 'profile HOME must stay under configured root');
      assert.ok(pro.homePath.startsWith(root), 'profile HOME must stay under configured root');

      const flashSettings = readJson(flash.settingsPath);
      const proSettings = readJson(pro.settingsPath);
      assert.equal(flashSettings.model, 'Gemini 3.5 Flash (High)');
      assert.equal(proSettings.model, 'Gemini 3.1 Pro (High)');
      assert.deepEqual(flashSettings.trustedWorkspaces, [worktree]);
      assert.deepEqual(proSettings.trustedWorkspaces, [worktree]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('requires an explicit AGY profile model label instead of falling back to catalog model id', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-profile-root-'));
    const worktree = mkdtempSync(join(tmpdir(), 'agy-profile-worktree-'));
    const settingsPath = join(root, 'gemini35', '.gemini', 'antigravity-cli', 'settings.json');

    try {
      assert.throws(
        () =>
          resolveAgyProfile({
            catId: 'gemini35',
            expectedModel: 'gemini-3.5-flash',
            workingDirectory: worktree,
            config: { enabled: true, homeRoot: root },
          }),
        /explicit.*AGY profile model/i,
      );
      assert.equal(existsSync(settingsPath), false, 'missing explicit AGY model label must not write settings');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('preflight fails closed on selected-model mismatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-profile-root-'));
    const worktree = mkdtempSync(join(tmpdir(), 'agy-profile-worktree-'));

    try {
      const profile = resolveAgyProfile({
        catId: 'gemini35',
        expectedModel: 'Gemini 3.5 Flash (High)',
        workingDirectory: worktree,
        config: { enabled: true, homeRoot: root, model: 'Gemini 3.5 Flash (High)' },
      });
      writeFileSync(
        profile.settingsPath,
        JSON.stringify({ model: 'Gemini 3.1 Pro (High)', trustedWorkspaces: [worktree] }, null, 2),
      );

      const result = preflightAgyProfile(profile, { agyCommand: '/tmp/fake-agy', workingDirectory: worktree });

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'model_mismatch');
      assert.match(result.message, /Gemini 3\.5 Flash/);
      assert.match(result.message, /Gemini 3\.1 Pro/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('expands tilde profile roots under the active HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-profile-home-'));
    const worktree = mkdtempSync(join(tmpdir(), 'agy-profile-worktree-'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const profile = resolveAgyProfile({
        catId: 'gemini35',
        expectedModel: 'Gemini 3.5 Flash (High)',
        workingDirectory: worktree,
        config: { enabled: true, homeRoot: '~/agy-profiles', model: 'Gemini 3.5 Flash (High)' },
      });

      assert.equal(profile.homePath, join(home, 'agy-profiles', 'gemini35'));
    } finally {
      if (savedHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = savedHome;
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('preflight fails closed when assigned worktree is not trusted', () => {
    const root = mkdtempSync(join(tmpdir(), 'agy-profile-root-'));
    const worktree = mkdtempSync(join(tmpdir(), 'agy-profile-worktree-'));
    const otherWorktree = mkdtempSync(join(tmpdir(), 'agy-profile-other-worktree-'));

    try {
      const profile = resolveAgyProfile({
        catId: 'gemini35',
        expectedModel: 'Gemini 3.5 Flash (High)',
        workingDirectory: worktree,
        config: { enabled: true, homeRoot: root, model: 'Gemini 3.5 Flash (High)' },
      });
      writeFileSync(
        profile.settingsPath,
        JSON.stringify({ model: 'Gemini 3.5 Flash (High)', trustedWorkspaces: [otherWorktree] }, null, 2),
      );

      const result = preflightAgyProfile(profile, { agyCommand: '/tmp/fake-agy', workingDirectory: worktree });

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'untrusted_workspace');
      assert.match(result.message, /trusted/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
      rmSync(otherWorktree, { recursive: true, force: true });
    }
  });

  test('rejects real HOME profile target before creating settings files', () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-real-home-'));
    const worktree = mkdtempSync(join(tmpdir(), 'agy-profile-worktree-'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');

    try {
      assert.throws(
        () =>
          resolveAgyProfile({
            catId: 'gemini35',
            expectedModel: 'Gemini 3.5 Flash (High)',
            workingDirectory: worktree,
            config: {
              enabled: true,
              homeRoot: dirname(home),
              profileId: basename(home),
              model: 'Gemini 3.5 Flash (High)',
            },
          }),
        /real user HOME|Unsafe AGY profile/i,
      );
      assert.equal(existsSync(settingsPath), false, 'unsafe profile setup must not touch real HOME settings');
    } finally {
      if (savedHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = savedHome;
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('rejects symlinked profile HOME before writing through the link', () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-real-home-'));
    const root = mkdtempSync(join(tmpdir(), 'agy-profile-root-'));
    const worktree = mkdtempSync(join(tmpdir(), 'agy-profile-worktree-'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');

    try {
      symlinkSync(home, join(root, 'gemini35'), 'dir');

      assert.throws(
        () =>
          resolveAgyProfile({
            catId: 'gemini35',
            expectedModel: 'Gemini 3.5 Flash (High)',
            workingDirectory: worktree,
            config: { enabled: true, homeRoot: root, model: 'Gemini 3.5 Flash (High)' },
          }),
        /symlink|real user HOME|Unsafe AGY profile/i,
      );
      assert.equal(existsSync(settingsPath), false, 'symlinked profile setup must not touch real HOME settings');
    } finally {
      if (savedHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = savedHome;
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('rejects symlinked profile settings components before writing through them', () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-real-home-'));
    const root = mkdtempSync(join(tmpdir(), 'agy-profile-root-'));
    const worktree = mkdtempSync(join(tmpdir(), 'agy-profile-worktree-'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    const profileHome = join(root, 'gemini35');
    const settingsPath = join(home, '.gemini', 'antigravity-cli', 'settings.json');

    try {
      mkdirSync(profileHome, { recursive: true });
      mkdirSync(join(home, '.gemini'), { recursive: true });
      symlinkSync(join(home, '.gemini'), join(profileHome, '.gemini'), 'dir');

      assert.throws(
        () =>
          resolveAgyProfile({
            catId: 'gemini35',
            expectedModel: 'Gemini 3.5 Flash (High)',
            workingDirectory: worktree,
            config: { enabled: true, homeRoot: root, model: 'Gemini 3.5 Flash (High)' },
          }),
        /symlink|real user HOME|Unsafe AGY profile/i,
      );
      assert.equal(existsSync(settingsPath), false, 'symlinked settings component must not touch real HOME settings');
    } finally {
      if (savedHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = savedHome;
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
