import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SETUP_SH = join(PROJECT_ROOT, 'scripts', 'setup.sh');
const INSTALL_SH = join(PROJECT_ROOT, 'scripts', 'install.sh');
const INSTALL_PS1 = join(PROJECT_ROOT, 'scripts', 'install.ps1');
const INSTALL_HELPERS_PS1 = join(PROJECT_ROOT, 'scripts', 'install-windows-helpers.ps1');

/** HOME-level skill directory patterns that install scripts must NOT create */
const POSIX_HOME_SKILL_PATTERNS = [
  /\$HOME\/\.claude\/skills/,
  /\$HOME\/\.codex\/skills/,
  /\$HOME\/\.gemini\/skills/,
  /\$HOME\/\.kimi\/skills/,
];

const WINDOWS_HOME_SKILL_PATTERNS = [
  /\$env:USERPROFILE\\\.claude\\skills/,
  /\$env:USERPROFILE\\\.codex\\skills/,
  /\$env:USERPROFILE\\\.gemini\\skills/,
  /\$env:USERPROFILE\\\.kimi\\skills/,
];

/**
 * ADR-025 boundary validation: install scripts must NOT create HOME-level
 * skill symlinks. Project-level links are created at runtime by
 * GovernanceBootstrapService / /api/skills/sync — not by install scripts.
 */
describe('install scripts do not create HOME-level skill links (ADR-025)', () => {
  // ── POSIX: setup.sh ──────────────────────────────────────

  describe('setup.sh', () => {
    let content;

    it('exists and is readable', async () => {
      content = await readFile(SETUP_SH, 'utf-8');
      assert.ok(content.length > 0);
    });

    it('does not link skills to $HOME/.{provider}/skills', async () => {
      if (!content) content = await readFile(SETUP_SH, 'utf-8');
      for (const pat of POSIX_HOME_SKILL_PATTERNS) {
        assert.ok(!pat.test(content), `setup.sh must not reference ${pat}`);
      }
    });

    it('does not contain ln -sfn for skills', async () => {
      if (!content) content = await readFile(SETUP_SH, 'utf-8');
      assert.ok(!content.includes('ln -sfn'), 'setup.sh must not contain "ln -sfn"');
    });
  });

  // ── POSIX: install.sh ────────────────────────────────────

  describe('install.sh', () => {
    let content;

    it('exists and is readable', async () => {
      content = await readFile(INSTALL_SH, 'utf-8');
      assert.ok(content.length > 0);
    });

    it('does not link skills to $HOME/.{provider}/skills', async () => {
      if (!content) content = await readFile(INSTALL_SH, 'utf-8');
      for (const pat of POSIX_HOME_SKILL_PATTERNS) {
        assert.ok(!pat.test(content), `install.sh must not reference ${pat}`);
      }
    });
  });

  // ── Windows: install.ps1 ─────────────────────────────────

  describe('install.ps1', () => {
    let content;

    it('exists and is readable', async () => {
      content = await readFile(INSTALL_PS1, 'utf-8');
      assert.ok(content.length > 0);
    });

    it('does not link skills to $env:USERPROFILE/.{provider}/skills', async () => {
      if (!content) content = await readFile(INSTALL_PS1, 'utf-8');
      for (const pat of WINDOWS_HOME_SKILL_PATTERNS) {
        assert.ok(!pat.test(content), `install.ps1 must not reference ${pat}`);
      }
    });

    it('does not call Mount-InstallerSkills', async () => {
      if (!content) content = await readFile(INSTALL_PS1, 'utf-8');
      assert.ok(!content.includes('Mount-InstallerSkills'), 'install.ps1 must not call Mount-InstallerSkills');
    });

    it('does not contain mklink /J for skills', async () => {
      if (!content) content = await readFile(INSTALL_PS1, 'utf-8');
      assert.ok(!content.includes('mklink /J'), 'install.ps1 must not contain "mklink /J"');
    });
  });

  // ── Windows: install-windows-helpers.ps1 ─────────────────

  describe('install-windows-helpers.ps1', () => {
    let content;

    it('exists and is readable', async () => {
      content = await readFile(INSTALL_HELPERS_PS1, 'utf-8');
      assert.ok(content.length > 0);
    });

    it('does not define Mount-InstallerSkills', async () => {
      if (!content) content = await readFile(INSTALL_HELPERS_PS1, 'utf-8');
      assert.ok(!content.includes('Mount-InstallerSkills'), 'helpers must not define Mount-InstallerSkills');
    });

    it('does not define Get-InstallerSkillLinkTarget', async () => {
      if (!content) content = await readFile(INSTALL_HELPERS_PS1, 'utf-8');
      assert.ok(
        !content.includes('Get-InstallerSkillLinkTarget'),
        'helpers must not define Get-InstallerSkillLinkTarget',
      );
    });

    it('does not define Get-InstallerNormalizedPath', async () => {
      if (!content) content = await readFile(INSTALL_HELPERS_PS1, 'utf-8');
      assert.ok(
        !content.includes('Get-InstallerNormalizedPath'),
        'helpers must not define Get-InstallerNormalizedPath',
      );
    });
  });
});

/**
 * Runtime governance path still creates project-level skill links.
 * This validates the complement: what install scripts no longer do,
 * GovernanceBootstrapService / skill-sync still does.
 */
describe('runtime governance creates project-level skill links (ADR-025)', () => {
  const BOOTSTRAP_SRC = join(PROJECT_ROOT, 'packages', 'api', 'src', 'config', 'governance', 'governance-bootstrap.ts');
  const SKILL_SYNC_SRC = join(PROJECT_ROOT, 'packages', 'api', 'src', 'config', 'governance', 'skill-sync.ts');
  const PREFLIGHT_SRC = join(PROJECT_ROOT, 'packages', 'api', 'src', 'config', 'governance', 'governance-preflight.ts');

  it('GovernanceBootstrapService creates per-skill symlinks at project level', async () => {
    const content = await readFile(BOOTSTRAP_SRC, 'utf-8');
    assert.ok(content.includes('.claude/skills'), 'governance-bootstrap must reference .claude/skills');
    assert.ok(content.includes('.codex/skills'), 'governance-bootstrap must reference .codex/skills');
    assert.ok(content.includes('.gemini/skills'), 'governance-bootstrap must reference .gemini/skills');
    assert.ok(content.includes('.kimi/skills'), 'governance-bootstrap must reference .kimi/skills');
    assert.ok(content.includes("IS_WIN32 ? 'junction'"), 'governance-bootstrap must use junction on Windows');
  });

  it('skill-sync creates per-skill symlinks at project level', async () => {
    const content = await readFile(SKILL_SYNC_SRC, 'utf-8');
    assert.ok(content.includes('.claude/skills'), 'skill-sync must reference .claude/skills');
    assert.ok(content.includes('.codex/skills'), 'skill-sync must reference .codex/skills');
    assert.ok(content.includes('.gemini/skills'), 'skill-sync must reference .gemini/skills');
    assert.ok(content.includes('.kimi/skills'), 'skill-sync must reference .kimi/skills');
    assert.ok(content.includes("process.platform === 'win32'"), 'skill-sync must handle Windows junction');
  });

  it('governance preflight checks skill symlinks are present', async () => {
    const content = await readFile(PREFLIGHT_SRC, 'utf-8');
    assert.ok(content.includes('skills'), 'governance-preflight must reference skills');
  });
});
