import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'sync-skills.sh');
const PROVIDERS = ['claude', 'codex', 'gemini', 'kimi'];

function addSkill(worktree, name) {
  const skillDir = join(worktree, 'cat-cafe-skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `# ${name}\n`);
}

function addSharedRefs(worktree) {
  const refsDir = join(worktree, 'cat-cafe-skills', 'refs');
  mkdirSync(refsDir, { recursive: true });
  writeFileSync(join(refsDir, 'README.md'), 'fixture refs\n');
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'f301-sync-skills-'));
  const fixture = {
    root,
    home: join(root, 'home'),
    main: join(root, 'main'),
    current: join(root, 'current'),
    peer: join(root, 'peer'),
  };
  for (const worktree of [fixture.main, fixture.current, fixture.peer]) {
    addSharedRefs(worktree);
  }
  addSkill(fixture.main, 'main-only');
  addSkill(fixture.current, 'current-only');
  addSkill(fixture.peer, 'peer-only');

  const correctDir = join(fixture.current, '.claude', 'skills');
  mkdirSync(correctDir, { recursive: true });
  symlinkSync('../../cat-cafe-skills/current-only', join(correctDir, 'current-only'));

  const staleDir = join(fixture.current, '.gemini', 'skills');
  mkdirSync(staleDir, { recursive: true });
  symlinkSync('../../wrong-target', join(staleDir, 'current-only'));

  const externalDir = join(fixture.peer, '.claude', 'skills', 'external-skill');
  mkdirSync(externalDir, { recursive: true });
  writeFileSync(join(externalDir, 'SKILL.md'), '# external\n');
  fixture.foreignTarget = join(root, 'foreign-skill');
  mkdirSync(fixture.foreignTarget);
  mkdirSync(join(fixture.peer, '.codex', 'skills'), { recursive: true });
  symlinkSync(fixture.foreignTarget, join(fixture.peer, '.codex', 'skills', 'foreign-skill'));

  const wrapperDir = join(root, 'bin');
  mkdirSync(wrapperDir);
  writeFileSync(
    join(wrapperDir, 'git'),
    [
      '#!/usr/bin/env bash',
      'set -e',
      'if [[ "$1" == "worktree" && "$2" == "list" && "$3" == "--porcelain" ]]; then',
      '  printf "worktree %s\\n\\n" "$SYNC_MAIN"',
      '  printf "worktree %s\\n\\n" "$SYNC_CURRENT"',
      '  printf "worktree %s\\n\\n" "$SYNC_PEER"',
      '  exit 0',
      'fi',
      'if [[ "$1" == "rev-parse" && "$2" == "--show-toplevel" ]]; then',
      '  printf "%s\\n" "$SYNC_CURRENT"',
      '  exit 0',
      'fi',
      'if [[ "$1" == "-C" && "$3" == "rev-parse" && "$4" == "--abbrev-ref" && "$5" == "HEAD" ]]; then',
      '  printf "feat/fixture\\n"',
      '  exit 0',
      'fi',
      'printf "unsupported git invocation: %s\\n" "$*" >&2',
      'exit 64',
    ].join('\n'),
    { mode: 0o755 },
  );
  fixture.wrapperDir = wrapperDir;
  return fixture;
}

function runSync(fixture, args = []) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd: fixture.current,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: `${fixture.wrapperDir}:${process.env.PATH}`,
      SYNC_MAIN: fixture.main,
      SYNC_CURRENT: fixture.current,
      SYNC_PEER: fixture.peer,
    },
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
function plain(output) {
  return output.replace(ANSI_ESCAPE_RE, '');
}

function assertManagedLink(worktree, provider, skill) {
  const link = join(worktree, `.${provider}`, 'skills', skill);
  assert.ok(existsSync(link), `missing ${link}`);
  assert.ok(lstatSync(link).isSymbolicLink(), `${link} must be a symlink`);
  assert.equal(readlinkSync(link), `../../cat-cafe-skills/${skill}`);
}

describe('F301 scoped sync-skills CLI', () => {
  let fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('defaults to the invoking worktree and its local skill source', () => {
    const result = runSync(fixture);
    assert.equal(result.status, 0, result.stderr);

    for (const provider of PROVIDERS) {
      assertManagedLink(fixture.current, provider, 'current-only');
      assert.equal(
        existsSync(join(fixture.peer, `.${provider}`, 'skills', 'peer-only')),
        false,
        `default mode must not touch peer ${provider} mount`,
      );
    }
    assert.equal(
      existsSync(join(fixture.main, '.claude', 'skills', 'main-only')),
      false,
      'default mode must not mutate main worktree mounts',
    );
    assert.equal(
      existsSync(join(fixture.main, '.cat-cafe', 'capabilities.json')),
      false,
      'default mode must not write sync state into another worktree',
    );
    assert.ok(
      existsSync(join(fixture.current, '.cat-cafe', 'capabilities.json')),
      'default mode must record sync state in the invoking worktree',
    );
  });

  it('repairs every worktree only when --all is explicit', () => {
    const result = runSync(fixture, ['--all']);
    assert.equal(result.status, 0, result.stderr);

    for (const provider of PROVIDERS) {
      assertManagedLink(fixture.main, provider, 'main-only');
      assertManagedLink(fixture.current, provider, 'current-only');
      assertManagedLink(fixture.peer, provider, 'peer-only');
    }
  });

  it('preserves external directories and foreign links in both scopes', () => {
    const defaultResult = runSync(fixture);
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    const allResult = runSync(fixture, ['--all']);
    assert.equal(allResult.status, 0, allResult.stderr);

    const externalDir = join(fixture.peer, '.claude', 'skills', 'external-skill');
    const foreignLink = join(fixture.peer, '.codex', 'skills', 'foreign-skill');
    assert.ok(lstatSync(externalDir).isDirectory(), 'external skill directory must stay real');
    assert.ok(lstatSync(foreignLink).isSymbolicLink(), 'foreign symlink must remain untouched');
    assert.equal(readlinkSync(foreignLink), fixture.foreignTarget, 'foreign symlink target must remain unchanged');
  });

  it('uses a concise summary by default and expands actions only with --verbose', () => {
    const summaryResult = runSync(fixture);
    assert.equal(summaryResult.status, 0, summaryResult.stderr);
    const summary = plain(summaryResult.stdout);
    assert.match(summary, /Scope: current/);
    assert.match(summary, /Targets: 4 provider surfaces/);
    assert.doesNotMatch(summary, /\[action\]/);

    const verboseResult = runSync(fixture, ['--verbose']);
    assert.equal(verboseResult.status, 0, verboseResult.stderr);
    assert.match(plain(verboseResult.stdout), /\[action\]/);
  });
});
