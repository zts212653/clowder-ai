const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveDesktopRuntime } = require('./runtime-config');

const script = path.join(__dirname, 'scripts/configure-desktop-instance.ps1');
const saved = {
  CAT_CAFE_DESKTOP_INSTANCE_ROOT: 'C:\\fixture-owned-instance',
  FRONTEND_PORT: '5158',
  API_SERVER_PORT: '3158',
  REDIS_PORT: '6367',
};
function configure(root, args = []) {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-AppDir', root, ...args],
    { timeout: 60000, stdio: 'pipe' },
  );
}

function currentSid() {
  return execFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  }).match(/,"(S-1-\d+(?:-\d+)+)"/)?.[1];
}

function profilePowerShell(target, script, extraEnv = {}) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  return execFileSync(path.join(powershell, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv, SG_ACL_PATH: target, PSModulePath: path.join(powershell, 'Modules') },
    windowsHide: true,
  });
}

function aclFor(target) {
  const script = [
    '$acl = Get-Acl -LiteralPath $env:SG_ACL_PATH',
    '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    '$entries = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])',
    '$rules = @($entries | ForEach-Object { $_.IdentityReference.Value })',
    '$full = [System.Security.AccessControl.FileSystemRights]::FullControl',
    '$fullGrants = @($entries | Where-Object { $_.AccessControlType -eq "Allow" -and $_.FileSystemRights -eq $full -and $_.InheritanceFlags -eq "ContainerInherit, ObjectInherit" -and $_.PropagationFlags -eq "None" } | ForEach-Object { $_.IdentityReference.Value })',
    '$denials = @($entries | Where-Object { $_.AccessControlType -eq "Deny" }).Count',
    '[pscustomobject]@{owner=$owner; protected=$acl.AreAccessRulesProtected; rules=$rules; fullGrants=$fullGrants; denials=$denials} | ConvertTo-Json -Compress',
  ].join('; ');
  return JSON.parse(profilePowerShell(target, script));
}

function setProfileDacl(target, dacl) {
  profilePowerShell(
    target,
    [
      '$ErrorActionPreference = "Stop"',
      '$acl = Get-Acl -LiteralPath $env:SG_ACL_PATH',
      '$acl.SetSecurityDescriptorSddlForm($env:SG_TEST_DACL, [System.Security.AccessControl.AccessControlSections]::Access)',
      'Set-Acl -LiteralPath $env:SG_ACL_PATH -AclObject $acl',
    ].join('; '),
    { SG_TEST_DACL: dacl },
  );
}

test('stable install marker remains authoritative after payload replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-install-identity-'));
  const payload = path.join(root, 'desktop-dist');
  fs.mkdirSync(payload);
  const identity = { ...saved, CAT_CAFE_DESKTOP_INSTANCE_ROOT: path.join(root, 'owned-instance') };
  try {
    fs.writeFileSync(path.join(root, 'desktop-instance.json'), JSON.stringify(identity));
    fs.writeFileSync(path.join(payload, 'desktop-instance.json'), JSON.stringify({ ...identity, REDIS_PORT: '6368' }));
    const actual = resolveDesktopRuntime({}, path.join(payload, 'Clowder AI.exe'));
    assert.equal(actual.redisPort, 6367);
    fs.writeFileSync(path.join(root, 'desktop-instance.json'), '{bad');
    assert.throws(() => resolveDesktopRuntime({}, path.join(payload, 'Clowder AI.exe')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'upgrade migrates legacy identity before replacement and preserves it without repeated parameters',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-install-upgrade-'));
    const payload = path.join(root, 'desktop-dist');
    fs.mkdirSync(payload);
    const data = path.join(root, 'owned-data');
    fs.mkdirSync(data);
    const body = JSON.stringify({ ...saved, CAT_CAFE_DESKTOP_INSTANCE_ROOT: data });
    const witness = path.join(data, 'roles-and-messages.json');
    fs.writeFileSync(witness, '{"role":"old-id","message":"history"}');
    try {
      fs.writeFileSync(path.join(payload, 'desktop-instance.json'), body);
      configure(root);
      assert.equal(fs.readFileSync(path.join(root, 'desktop-instance.json'), 'utf8'), body);
      // Simulate the exact payload replacement boundary; owned data is outside it.
      fs.renameSync(payload, path.join(root, 'previous-payload'));
      fs.mkdirSync(payload);
      configure(root);
      assert.equal(resolveDesktopRuntime({}, path.join(payload, 'Clowder AI.exe')).instanceRoot, data);
      assert.equal(resolveDesktopRuntime({}, path.join(payload, 'Clowder AI.exe')).apiPort, 3158);
      assert.equal(fs.readFileSync(witness, 'utf8'), '{"role":"old-id","message":"history"}');
      assert.equal(fs.readFileSync(path.join(root, 'desktop-instance.json'), 'utf8'), body);
      assert.throws(() =>
        configure(root, ['-InstanceRoot', data, '-FrontendPort', '5160', '-ApiPort', '3160', '-RedisPort', '6370']),
      );
      assert.equal(fs.readFileSync(path.join(root, 'desktop-instance.json'), 'utf8'), body);
      fs.writeFileSync(path.join(root, 'desktop-instance.json'), '{invalid');
      assert.throws(() => configure(root));
      assert.equal(fs.readFileSync(path.join(root, 'desktop-instance.json'), 'utf8'), '{invalid');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('installer preserves identity before any payload delete', () => {
  const prepare = fs.readFileSync(path.join(__dirname, 'installer/install-preparation.iss'), 'utf8');
  assert.match(prepare, /configure-desktop-instance\.ps1/);
  assert.ok(prepare.indexOf('configure-desktop-instance.ps1') < prepare.indexOf('stop-installed-desktop.ps1'));
  assert.match(prepare, /Result := CustomMessage\('SetupIdentityFailed'\)/);
});

test(
  'ordinary Windows setup keeps new state on the selected install drive and retains it on upgrade',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'default-install-state-'));
    const app = path.join(root, 'chosen location');
    const program = path.join(app, 'desktop-dist', 'Clowder AI.exe');
    const marker = path.join(app, 'desktop-data-root.json');
    try {
      configure(app);
      const body = fs.readFileSync(marker, 'utf8');
      const { dataRoot } = resolveDesktopRuntime({}, program);
      assert.equal(path.dirname(dataRoot), fs.realpathSync.native(path.join(app, 'user-state')));
      assert.match(path.basename(dataRoot), /^S-1-\d+(?:-\d+)+$/);
      assert.equal(aclFor(dataRoot).protected, true);
      fs.mkdirSync(dataRoot, { recursive: true });
      const witness = path.join(dataRoot, 'test-conversation');
      fs.writeFileSync(witness, 'retained');
      fs.mkdirSync(path.dirname(program), { recursive: true });
      fs.writeFileSync(program, '');
      // Replace the packaged payload in place; the SID profile must stay outside it.
      fs.renameSync(path.dirname(program), path.join(app, 'previous-desktop-dist'));
      fs.mkdirSync(path.dirname(program), { recursive: true });
      fs.writeFileSync(program, '');
      configure(app, ['-ExistingInstallation']);
      assert.equal(fs.readFileSync(marker, 'utf8'), body);
      assert.equal(resolveDesktopRuntime({}, program).dataRoot, dataRoot);
      assert.equal(fs.readFileSync(witness, 'utf8'), 'retained');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'install profile resolution is reusable across repeated runtime lookups',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-repeat-resolve-'));
    const app = path.join(root, 'installed');
    const program = path.join(app, 'desktop-dist', 'Clowder AI.exe');
    try {
      configure(app);
      fs.mkdirSync(path.dirname(program), { recursive: true });
      fs.writeFileSync(program, '');
      const first = resolveDesktopRuntime({}, program);
      const second = resolveDesktopRuntime({}, program);
      assert.equal(second.dataRoot, first.dataRoot);
      assert.equal(second.useInstallDataRoot, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'install mode rejects a SID junction into the payload before writing data',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-junction-install-'));
    const app = path.join(root, 'installed');
    const payload = path.join(app, 'packages', 'api');
    const userState = path.join(app, 'user-state');
    const program = path.join(app, 'desktop-dist', 'Clowder AI.exe');
    const sid = currentSid();
    const link = path.join(userState, sid);
    const sentinel = path.join(payload, 'keep.txt');
    fs.mkdirSync(payload, { recursive: true });
    fs.mkdirSync(userState, { recursive: true });
    fs.mkdirSync(path.dirname(program), { recursive: true });
    fs.writeFileSync(sentinel, 'payload remains');
    fs.writeFileSync(path.join(app, 'desktop-data-root.json'), '{"mode":"install"}');
    fs.writeFileSync(program, '');
    fs.symlinkSync(payload, link, 'junction');
    try {
      assert.throws(
        () => resolveDesktopRuntime({}, program),
        /replacement boundary|owner\/ACL|reparse|owned by another/i,
      );
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'payload remains');
    } finally {
      try {
        execFileSync('cmd.exe', ['/c', 'rmdir', link], { stdio: 'pipe' });
      } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'install mode rejects a SID profile whose owner is another principal',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-owner-install-'));
    const app = path.join(root, 'installed');
    const program = path.join(app, 'desktop-dist', 'Clowder AI.exe');
    const sid = currentSid();
    const profile = path.join(app, 'user-state', sid);
    try {
      fs.mkdirSync(profile, { recursive: true });
      fs.mkdirSync(path.dirname(program), { recursive: true });
      fs.writeFileSync(path.join(app, 'desktop-data-root.json'), '{"mode":"install"}');
      fs.writeFileSync(program, '');
      execFileSync('icacls', [profile, '/setowner', '*S-1-5-32-545'], { stdio: 'pipe' });
      assert.throws(() => resolveDesktopRuntime({}, program), /owner\/ACL|owned by another/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'install mode accepts a pre-created SID profile owned by this account',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-own-owner-'));
    const app = path.join(root, 'installed');
    const program = path.join(app, 'desktop-dist', 'Clowder AI.exe');
    const sid = currentSid();
    const profile = path.join(app, 'user-state', sid);
    const witness = path.join(profile, 'existing-conversation');
    try {
      configure(app);
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(witness, 'existing data');
      execFileSync('icacls.exe', [profile, '/setowner', `*${sid}`], { stdio: 'pipe' });
      const resolved = resolveDesktopRuntime({}, program);
      assert.equal(resolved.dataRoot, path.join(fs.realpathSync.native(path.join(app, 'user-state')), sid));
      assert.equal(fs.readFileSync(witness, 'utf8'), 'existing data');
      assert.equal(aclFor(profile).protected, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'install mode removes explicit external ACL entries from an existing SID profile',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-external-acl-'));
    const app = path.join(root, 'installed');
    const program = path.join(app, 'desktop-dist', 'Clowder AI.exe');
    const sid = currentSid();
    const profile = path.join(app, 'user-state', sid);
    const witness = path.join(profile, 'existing-conversation');
    try {
      configure(app);
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(witness, 'existing data');
      execFileSync('icacls.exe', [profile, '/grant', '*S-1-5-32-545:(OI)(CI)F'], { stdio: 'pipe' });
      assert.equal(aclFor(profile).rules.includes('S-1-5-32-545'), true);
      resolveDesktopRuntime({}, program);
      const acl = aclFor(profile);
      assert.equal(acl.protected, true);
      assert.equal(acl.rules.includes('S-1-5-32-545'), false);
      assert.equal(fs.readFileSync(witness, 'utf8'), 'existing data');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

for (const [description, rule] of [
  ['no ACEs', ''],
  ['an explicit write denial', '(D;;FW;;;{sid})(A;OICI;FA;;;{sid})'],
  ['only read access for its user', '(A;OICI;FR;;;{sid})(A;OICI;FA;;;BA)'],
  ['a full grant that only applies to descendants', '(A;OICIIO;FA;;;{sid})(A;OICI;FA;;;BA)'],
]) {
  test(
    `install mode repairs a protected SID profile with ${description}`,
    { skip: process.platform !== 'win32' },
    () => {
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sid-effective-acl-')));
      assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
      assert.match(path.basename(root), /^sid-effective-acl-/);
      const sid = currentSid();
      const profile = path.join(root, 'user-state', sid);
      const program = path.join(root, 'desktop-dist', 'Clowder AI.exe');
      try {
        fs.mkdirSync(profile, { recursive: true });
        fs.writeFileSync(path.join(root, 'desktop-data-root.json'), '{"mode":"install"}');
        const witness = path.join(profile, 'existing-conversation');
        fs.writeFileSync(witness, 'retained');
        const icacls = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
        execFileSync(icacls, [profile, '/setowner', `*${sid}`], { stdio: 'pipe' });
        setProfileDacl(profile, `D:P${rule.replaceAll('{sid}', sid)}`);
        const before = aclFor(profile);
        assert.equal(before.protected, true);
        assert.ok(before.denials > 0 || !before.fullGrants.includes(sid), 'fixture must lack usable profile access');

        const { dataRoot } = resolveDesktopRuntime({}, program);
        assert.equal(dataRoot, profile);
        const after = aclFor(profile);
        assert.equal(after.protected, true);
        assert.equal(after.denials, 0);
        assert.ok(after.fullGrants.includes(sid), 'current SID must have an effective, inheritable FullControl grant');
        assert.equal(fs.readFileSync(witness, 'utf8'), 'retained');
        const data = path.join(profile, 'Clowder AI', 'data');
        fs.mkdirSync(data, { recursive: true });
        fs.writeFileSync(path.join(data, 'test-record'), 'writable');
        assert.equal(fs.readFileSync(path.join(data, 'test-record'), 'utf8'), 'writable');
      } finally {
        if (fs.existsSync(profile)) setProfileDacl(profile, `D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;BA)`);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test(
  'install mode hardens an existing trusted-owner SID profile without moving its data',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-legacy-acl-'));
    const app = path.join(root, 'installed');
    const program = path.join(app, 'desktop-dist', 'Clowder AI.exe');
    const sid = currentSid();
    const profile = path.join(app, 'user-state', sid);
    const witness = path.join(profile, 'old-conversation');
    try {
      configure(app);
      fs.mkdirSync(profile, { recursive: true });
      fs.writeFileSync(witness, 'old data');
      execFileSync('icacls', [profile, '/inheritance:e'], { stdio: 'pipe' });
      assert.equal(aclFor(profile).protected, false);
      const resolved = resolveDesktopRuntime({}, program);
      assert.equal(resolved.dataRoot, path.join(fs.realpathSync.native(path.join(app, 'user-state')), sid));
      assert.equal(aclFor(profile).protected, true);
      assert.equal(fs.readFileSync(witness, 'utf8'), 'old data');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'ordinary Windows upgrade preserves the legacy profile without a data marker',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'previous-install-state-'));
    const program = path.join(root, 'desktop-dist', 'Clowder AI.exe');
    try {
      fs.mkdirSync(path.dirname(program));
      fs.writeFileSync(program, '');
      configure(root, ['-ExistingInstallation']);
      assert.equal(fs.existsSync(path.join(root, 'desktop-data-root.json')), false);
      assert.equal(fs.existsSync(path.join(root, 'user-state')), false);
      assert.equal(resolveDesktopRuntime({}, program).dataRoot, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('setup configures and preserves an external persistent data root', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-install-'));
  const app = path.join(root, 'installed');
  const data = path.join(root, 'data');
  const other = path.join(root, 'other');
  const marker = path.join(app, 'desktop-data-root.json');
  fs.mkdirSync(data);
  fs.mkdirSync(other);
  try {
    configure(app, ['-DataRoot', data]);
    const body = fs.readFileSync(marker, 'utf8');
    assert.equal(JSON.parse(body).dataRoot, fs.realpathSync.native(data));
    configure(app);
    configure(app, ['-DataRoot', data]);
    assert.throws(() => configure(app, ['-DataRoot', other]), /conflicts/);
    assert.throws(() => configure(app, ['-InstanceRoot', data]), /choose either/i);
    assert.equal(fs.readFileSync(marker, 'utf8'), body);

    const isolated = path.join(root, 'isolated');
    fs.mkdirSync(isolated);
    fs.writeFileSync(
      path.join(isolated, 'desktop-instance.json'),
      JSON.stringify({ ...saved, CAT_CAFE_DESKTOP_INSTANCE_ROOT: data }),
    );
    assert.throws(() => configure(isolated, ['-DataRoot', data]), /choose either/i);
    assert.equal(fs.existsSync(path.join(isolated, 'desktop-data-root.json')), false);

    const nested = path.join(root, 'nested-app');
    fs.mkdirSync(nested);
    assert.throws(() => configure(nested, ['-DataRoot', nested]), /outside the installation/i);
    assert.throws(() => configure(nested, ['-DataRoot', path.join(root, 'missing')]), /existing directory/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
