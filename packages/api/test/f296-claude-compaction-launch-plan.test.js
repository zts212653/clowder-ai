import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative as relativePath } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const { buildClaudeCompactionLaunchPlan, composeManagedSettingsDocument, CLAUDE_COMPACTION_CARRIER_IDENTITY } =
  await import('../dist/domains/cats/services/agents/providers/claude-compaction-launch-plan.js');

const roots = [];

function carrierRoot({ valid = true, linked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'f296-launch-plan-'));
  roots.push(root);
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
  const scriptPath = join(root, '.claude', 'hooks', 'f24-compaction.mjs');
  const source = valid
    ? [
        '// fixture canonical Node carrier',
        'fetch("/api/sessions/seal"',
        'CAT_CAFE_INVOCATION_ID CAT_CAFE_CALLBACK_TOKEN CAT_CAFE_CREDENTIAL_FILE',
        'X-Invocation-Id X-Callback-Token X-Clowder-Compaction-Carrier',
      ].join('\n')
    : '// stale carrier without callback contract markers';
  writeFileSync(scriptPath, source);
  if (linked) {
    const target = `${scriptPath}.real`;
    rmSync(scriptPath);
    writeFileSync(target, source);
    symlinkSync(target, scriptPath);
  }
  return root;
}

function emptyRoot() {
  const root = mkdtempSync(join(tmpdir(), 'f296-launch-plan-empty-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.CAT_CAFE_COMPACTION_CARRIER_ROOT;
});

describe('F296 #1542 claude compaction launch plan', () => {
  test('resolves the canonical Node carrier from the install root with exact handler shapes', () => {
    const plan = buildClaudeCompactionLaunchPlan({ installRoot: carrierRoot() });
    assert.equal(plan.ready, true);
    assert.equal(plan.carrierIdentity, CLAUDE_COMPACTION_CARRIER_IDENTITY);
    assert.equal(plan.nodePath, process.execPath);
    assert.ok(plan.carrierScriptPath.endsWith('f24-compaction.mjs'));
    assert.ok(isAbsolute(plan.carrierScriptPath), 'carrier script must be an absolute install-root path');
    assert.equal(plan.preCompactCommand, `"${plan.nodePath}" "${plan.carrierScriptPath}" pre`);
    assert.equal(plan.sessionStartCommand, `"${plan.nodePath}" "${plan.carrierScriptPath}" post`);

    const settings = JSON.parse(plan.settingsDocument);
    assert.equal(settings.hooks.PreCompact[0].matcher, 'manual|auto');
    assert.equal(settings.hooks.PreCompact[0].hooks[0].command, plan.preCompactCommand);
    assert.equal(settings.hooks.SessionStart[0].matcher, 'compact');
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, plan.sessionStartCommand);
    assert.equal(settings.disableAllHooks, undefined, 'must never force disableAllHooks: false');
    assert.ok(plan.planIdentity.length > 0);
  });

  test('CAT_CAFE_COMPACTION_CARRIER_ROOT overrides the install root (canonicalized)', () => {
    const root = carrierRoot();
    process.env.CAT_CAFE_COMPACTION_CARRIER_ROOT = root;
    const plan = buildClaudeCompactionLaunchPlan();
    assert.equal(plan.ready, true);
    // macOS /var → /private/var: the coordinate is the REALPATH of the root.
    const canonicalRoot = realpathSync.native(root);
    assert.equal(plan.carrierScriptPath, join(canonicalRoot, '.claude', 'hooks', 'f24-compaction.mjs'));
  });

  test('fails closed on missing or marker-less carrier assets', () => {
    assert.deepEqual(buildClaudeCompactionLaunchPlan({ installRoot: emptyRoot() }), {
      ready: false,
      reason: 'carrier_script_unresolved',
    });
    assert.equal(
      buildClaudeCompactionLaunchPlan({ installRoot: carrierRoot({ valid: false }) }).reason,
      'carrier_script_invalid',
    );
  });

  test('fails closed on a final-component symlinked carrier', { skip: process.platform === 'win32' }, () => {
    // File symlinks need elevated privileges on Windows; the equivalent
    // directory-junction escape runs in the intermediate-escape test below.
    assert.equal(
      buildClaudeCompactionLaunchPlan({ installRoot: carrierRoot({ linked: true }) }).reason,
      'carrier_script_unresolved',
    );
  });

  test('a relative explicit/env root is canonicalized to an absolute coordinate (#1542 delta P1)', () => {
    const root = carrierRoot();
    const relative = relativePath(process.cwd(), root);
    const plan = buildClaudeCompactionLaunchPlan({ installRoot: relative });
    assert.equal(plan.ready, true);
    assert.ok(isAbsolute(plan.carrierScriptPath), 'the carrier coordinate must be absolute');
    assert.ok(plan.preCompactCommand.includes(`"${plan.carrierScriptPath}" pre`));

    // A root that does not exist fails closed (realpath throws).
    assert.equal(buildClaudeCompactionLaunchPlan({ installRoot: './no-such-root' }).ready, false);
  });

  test('an install root reached through a directory link resolves by real identity (#1542 final P1)', () => {
    // Root-level junction (Windows) / symlink (POSIX) to the install root:
    // the alias path must canonicalize to the real root and resolve the
    // carrier by real identity — the layout desktop installs use when the
    // app root is reached through a junction.
    const realRoot = carrierRoot();
    const aliasParent = emptyRoot();
    const alias = join(aliasParent, 'alias-to-install');
    symlinkSync(realRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');

    const plan = buildClaudeCompactionLaunchPlan({ installRoot: alias });
    assert.equal(plan.ready, true, 'a root-level link must resolve by real identity');
    const canonicalRoot = realpathSync.native(realRoot);
    assert.equal(plan.carrierScriptPath, join(canonicalRoot, '.claude', 'hooks', 'f24-compaction.mjs'));
  });

  test(
    'a case-variant install-root spelling canonicalizes (#1542 final P1, Windows Apps/apps)',
    { skip: process.platform !== 'win32' },
    () => {
      // Windows filesystems are case-insensitive: Apps/apps-style spellings of
      // the same install root must canonicalize to the real filesystem casing
      // before any containment or command derivation.
      const root = carrierRoot();
      const varied = root
        .split(/[\\/]/)
        .map((segment, index) => (index % 2 === 1 ? segment.toUpperCase() : segment))
        .join('\\');
      const plan = buildClaudeCompactionLaunchPlan({ installRoot: varied });
      assert.equal(plan.ready, true, 'case-variant root spellings must canonicalize');
      const canonicalRoot = realpathSync.native(root);
      assert.equal(plan.carrierScriptPath, join(canonicalRoot, '.claude', 'hooks', 'f24-compaction.mjs'));
    },
  );

  test('an intermediate .claude/hooks directory link escape fails closed (#1542 delta P1)', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'f296-intermediate-escape-'));
    roots.push(sandbox);
    const install = join(sandbox, 'install');
    const outside = join(sandbox, 'outside');
    mkdirSync(join(install, 'packages', 'api'), { recursive: true });
    mkdirSync(join(outside, 'hooks'), { recursive: true });
    writeFileSync(
      join(outside, 'hooks', 'f24-compaction.mjs'),
      [
        '// carrier outside the trusted install',
        'fetch("/api/sessions/seal"',
        'CAT_CAFE_INVOCATION_ID CAT_CAFE_CALLBACK_TOKEN CAT_CAFE_CREDENTIAL_FILE',
        'X-Invocation-Id X-Callback-Token X-Clowder-Compaction-Carrier',
      ].join('\n'),
    );
    // <install>/.claude is a link to <outside>: the joined path looks inside
    // the install, but its realpath resolves outside — must fail closed.
    // Directory junctions need no elevation on Windows; symlinks elsewhere.
    mkdirSync(install, { recursive: true });
    symlinkSync(outside, join(install, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');

    const plan = buildClaudeCompactionLaunchPlan({ installRoot: install });
    assert.equal(plan.ready, false, 'an intermediate-component escape must not produce a ready plan');
  });

  test('a missing carrier under the trusted root fails closed — no ancestor escape (#1542 delta P1-A)', () => {
    // Reviewer's synthetic packaged layout: the install tree contains no
    // carrier; a valid marker-bearing carrier exists ONLY at the sandbox root
    // (outside the installation). The old ancestor scan escaped and accepted
    // it — with callback credentials, an authority violation.
    const sandbox = mkdtempSync(join(tmpdir(), 'f296-escape-sandbox-'));
    roots.push(sandbox);
    const install = join(sandbox, 'install');
    mkdirSync(join(install, 'packages', 'api'), { recursive: true });
    mkdirSync(join(sandbox, '.claude', 'hooks'), { recursive: true });
    writeFileSync(
      join(sandbox, '.claude', 'hooks', 'f24-compaction.mjs'),
      [
        '// outside-the-install carrier',
        'fetch("/api/sessions/seal"',
        'CAT_CAFE_INVOCATION_ID CAT_CAFE_CALLBACK_TOKEN CAT_CAFE_CREDENTIAL_FILE',
        'X-Invocation-Id X-Callback-Token X-Clowder-Compaction-Carrier',
      ].join('\n'),
    );

    const fromPackageRoot = buildClaudeCompactionLaunchPlan({ installRoot: join(install, 'packages', 'api') });
    assert.equal(fromPackageRoot.ready, false, 'must not escape the install root via ancestors');
    const fromInstallRoot = buildClaudeCompactionLaunchPlan({ installRoot: install });
    assert.equal(fromInstallRoot.ready, false, 'must not accept the parent sandbox carrier');
  });

  test('install root is anchored to the module location, not the process CWD (#1542 P1-2)', () => {
    // The committed carrier asset lives at the repo install root; the compiled
    // module is anchored under it. From an unrelated CWD the plan must still
    // resolve — proving the trusted-anchor contract.
    const previousCwd = process.cwd();
    const elsewhere = emptyRoot();
    process.chdir(elsewhere);
    try {
      const plan = buildClaudeCompactionLaunchPlan();
      assert.equal(plan.ready, true, 'module-anchored resolution must survive an unrelated CWD');
      assert.ok(!plan.carrierScriptPath.startsWith(elsewhere), 'must not resolve from the stray CWD');
    } finally {
      process.chdir(previousCwd);
    }
  });

  test('a relative user --settings path resolves against the spawn workingDirectory (#1542 P1-3)', () => {
    const plan = buildClaudeCompactionLaunchPlan({ installRoot: carrierRoot() });
    const workspace = emptyRoot();
    writeFileSync(join(workspace, 'user-settings.json'), JSON.stringify({ env: { RELATIVE: 'ok' } }));

    const merged = JSON.parse(composeManagedSettingsDocument(plan, 'user-settings.json', workspace));
    assert.equal(merged.env.RELATIVE, 'ok', 'relative path must resolve from the spawn cwd, not the API cwd');
    assert.equal(merged.hooks.PreCompact[0].hooks[0].command, plan.preCompactCommand);

    const missingDir = emptyRoot();
    assert.throws(
      () => composeManagedSettingsDocument(plan, 'user-settings.json', missingDir),
      /cli_config_args_settings_invalid/,
      'a relative path absent from the spawn cwd must fail closed',
    );
  });

  test('composeManagedSettingsDocument preserves user settings and appends managed handlers', () => {
    const plan = buildClaudeCompactionLaunchPlan({ installRoot: carrierRoot() });
    assert.equal(composeManagedSettingsDocument(plan), plan.settingsDocument);

    const userDoc = {
      spinnerTipsEnabled: true,
      disableAllHooks: true,
      hooks: { PreCompact: [{ matcher: 'manual', hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
    };
    const merged = JSON.parse(composeManagedSettingsDocument(plan, JSON.stringify(userDoc)));
    assert.equal(merged.spinnerTipsEnabled, true, 'user non-hook settings survive');
    assert.equal(merged.disableAllHooks, true, 'user opt-out semantics survive (fail closed downstream)');
    assert.equal(merged.hooks.PreCompact.length, 2, 'user entry + managed entry');
    assert.equal(merged.hooks.PreCompact[0].hooks[0].command, 'echo user-hook');
    assert.equal(merged.hooks.PreCompact[1].hooks[0].command, plan.preCompactCommand);
    assert.equal(merged.hooks.SessionStart.length, 1, 'managed SessionStart appended');
    assert.equal(merged.hooks.SessionStart[0].hooks[0].command, plan.sessionStartCommand);

    const userFile = join(emptyRoot(), 'user-settings.json');
    writeFileSync(userFile, JSON.stringify({ env: { FOO: 'bar' } }));
    const fromFile = JSON.parse(composeManagedSettingsDocument(plan, userFile));
    assert.equal(fromFile.env.FOO, 'bar');
    assert.equal(fromFile.hooks.PreCompact[0].hooks[0].command, plan.preCompactCommand);

    assert.throws(
      () => composeManagedSettingsDocument(plan, '/nonexistent-settings.json'),
      /cli_config_args_settings_invalid/,
    );
    assert.throws(() => composeManagedSettingsDocument(plan, '{not json'), /cli_config_args_settings_invalid/);
  });
});
