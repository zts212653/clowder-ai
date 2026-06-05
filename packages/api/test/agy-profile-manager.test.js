import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';

const { preflightAgyProfile, resolveAgyProfile, resolveAgySpawnCwd } = await import(
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

  test('rejects symlinked profile cwd sandbox before writing through the link (cloud P2)', () => {
    const home = mkdtempSync(join(tmpdir(), 'agy-real-home-'));
    const root = mkdtempSync(join(tmpdir(), 'agy-profile-root-'));
    const worktree = mkdtempSync(join(tmpdir(), 'agy-profile-worktree-'));
    const leakTarget = mkdtempSync(join(tmpdir(), 'agy-leak-target-'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    const profileHome = join(root, 'gemini35');

    try {
      mkdirSync(profileHome, { recursive: true });
      // profile cwd 预置成 symlink → leakTarget：若不拒绝，mkdirSync(recursive) 跟随 link，
      // AGY cwd-relative cache 会落 leakTarget（repo/真 HOME），泄漏修复被绕过。
      symlinkSync(leakTarget, join(profileHome, 'cwd'), 'dir');

      assert.throws(
        () =>
          resolveAgyProfile({
            catId: 'gemini35',
            expectedModel: 'Gemini 3.5 Flash (High)',
            workingDirectory: worktree,
            config: { enabled: true, homeRoot: root, model: 'Gemini 3.5 Flash (High)' },
          }),
        /cwd sandbox must not be a symlink/i,
      );
      assert.equal(existsSync(join(leakTarget, 'cache')), false, 'symlinked cwd 不得被穿透写入');
    } finally {
      if (savedHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = savedHome;
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
      rmSync(leakTarget, { recursive: true, force: true });
    }
  });

  test('rejects symlinked no-profile cwd sandbox base before writing through the link (cloud P2)', () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'agy-cwd-root-'));
    const leakTarget = mkdtempSync(join(tmpdir(), 'agy-leak-target-'));
    const workDir = mkdtempSync(join(tmpdir(), 'agy-noprofile-workdir-'));
    const savedEnv = process.env.CAT_CAFE_AGY_CWD_ROOT;
    process.env.CAT_CAFE_AGY_CWD_ROOT = cwdRoot;

    try {
      // no-profile sandbox base = <root>/gemini 预置成 symlink → leakTarget（per-worktree 子目录会建在它下面）
      symlinkSync(leakTarget, join(cwdRoot, 'gemini'), 'dir');

      assert.throws(() => resolveAgySpawnCwd(null, 'gemini', workDir), /cwd sandbox base must not be a symlink/i);
      assert.equal(existsSync(join(leakTarget, 'cache')), false, 'symlinked sandbox base 不得被穿透写入');
    } finally {
      if (savedEnv === undefined) {
        delete process.env.CAT_CAFE_AGY_CWD_ROOT;
      } else {
        process.env.CAT_CAFE_AGY_CWD_ROOT = savedEnv;
      }
      rmSync(cwdRoot, { recursive: true, force: true });
      rmSync(leakTarget, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('no-profile spawn cwd is unique per worktree (cloud P1 — preserve AGY conversation isolation)', () => {
    const cwdRoot = mkdtempSync(join(tmpdir(), 'agy-cwd-root-'));
    const wtA = mkdtempSync(join(tmpdir(), 'agy-wt-a-'));
    const wtB = mkdtempSync(join(tmpdir(), 'agy-wt-b-'));
    const savedEnv = process.env.CAT_CAFE_AGY_CWD_ROOT;
    process.env.CAT_CAFE_AGY_CWD_ROOT = cwdRoot;

    try {
      const a = resolveAgySpawnCwd(null, 'gemini', wtA);
      const b = resolveAgySpawnCwd(null, 'gemini', wtB);
      const aAgain = resolveAgySpawnCwd(null, 'gemini', wtA);
      const base = join(cwdRoot, 'gemini');
      assert.ok(a.startsWith(`${base}/`) && b.startsWith(`${base}/`), '两个 worktree 都在同一 cat base 下');
      assert.notEqual(a, b, '不同 worktree → 不同 spawn cwd（避免 AGY conversation 命名空间串台）');
      assert.equal(a, aAgain, '同一 worktree → 确定性同一 spawn cwd（resume/list 稳定）');
    } finally {
      if (savedEnv === undefined) {
        delete process.env.CAT_CAFE_AGY_CWD_ROOT;
      } else {
        process.env.CAT_CAFE_AGY_CWD_ROOT = savedEnv;
      }
      rmSync(cwdRoot, { recursive: true, force: true });
      rmSync(wtA, { recursive: true, force: true });
      rmSync(wtB, { recursive: true, force: true });
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
