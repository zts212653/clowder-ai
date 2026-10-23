const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveDesktopRuntime } = require('./runtime-config');

function identity(root) {
  return { CAT_CAFE_DESKTOP_INSTANCE_ROOT: root, FRONTEND_PORT: '5162', API_SERVER_PORT: '3162', REDIS_PORT: '6338' };
}
function configure(install, root, extra = [], env = process.env) {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'scripts/configure-desktop-instance.ps1'),
      '-AppDir',
      install,
      ...(root ? ['-InstanceRoot', root, '-FrontendPort', '5162', '-ApiPort', '3162', '-RedisPort', '6338'] : []),
      ...extra,
    ],
    { stdio: 'pipe', timeout: 30000, windowsHide: true, env },
  );
}
const replacementDirectories = [
  'desktop-dist',
  'packages',
  'node',
  'node_modules',
  path.join('scripts', 'node_modules'),
  'bundled',
  path.join('cat-cafe-skills', '.cat-cafe-shared-refs'),
];
for (const directory of replacementDirectories) {
  test(`runtime rejects data inside replacement directory ${directory}`, () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-boundary-'));
    try {
      const root = path.join(own, 'install', directory, 'owned-data');
      fs.mkdirSync(root, { recursive: true });
      assert.throws(
        () => resolveDesktopRuntime(identity(root), path.join(own, 'install/desktop-dist/Clowder AI.exe')),
        /replacement boundary/i,
      );
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
  for (const mode of ['parameters', 'persistent', 'legacy']) {
    test(
      `pre-install refuses ${mode} data in ${directory} without touching identity or history`,
      { skip: process.platform !== 'win32' },
      () => {
        const own = fs.mkdtempSync(path.join(os.tmpdir(), 'preinstall-boundary-'));
        try {
          const install = path.join(own, 'install');
          const root = path.join(install, directory, 'owned-data');
          fs.mkdirSync(root, { recursive: true });
          const history = path.join(root, 'history.json');
          fs.writeFileSync(history, '{"catId":"old-cat","message":"keep me"}');
          const body = JSON.stringify(identity(root));
          const marker = path.join(
            install,
            mode === 'legacy' ? 'desktop-dist/desktop-instance.json' : 'desktop-instance.json',
          );
          if (mode !== 'parameters') {
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, body);
          }
          assert.throws(() => configure(install, mode === 'parameters' ? root : undefined), /replacement boundary/i);
          assert.throws(
            () => configure(install, mode === 'parameters' ? root : undefined, ['-ValidateOnly']),
            /replacement boundary/i,
          );
          assert.equal(fs.readFileSync(history, 'utf8'), '{"catId":"old-cat","message":"keep me"}');
          if (mode !== 'parameters') assert.equal(fs.readFileSync(marker, 'utf8'), body);
          if (mode !== 'persistent') assert.equal(fs.existsSync(path.join(install, 'desktop-instance.json')), false);
        } finally {
          fs.rmSync(own, { recursive: true, force: true });
        }
      },
    );
  }
}
test(
  'canonical alias cannot bypass pre-install or runtime checks; outside sibling data remains valid',
  { skip: process.platform !== 'win32' },
  () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-boundary-'));
    try {
      const install = path.join(own, 'install');
      const payload = path.join(install, 'bundled');
      fs.mkdirSync(payload, { recursive: true });
      const alias = path.join(own, 'alias');
      fs.symlinkSync(payload, alias, 'junction');
      const aliasedRoot = path.join(alias, 'not-created-yet');
      assert.throws(() => configure(install, aliasedRoot), /replacement boundary/i);
      assert.throws(
        () => resolveDesktopRuntime(identity(aliasedRoot), path.join(install, 'desktop-dist/Clowder AI.exe')),
        /replacement boundary/i,
      );
      const outside = path.join(own, 'install-sibling/owned-data');
      fs.mkdirSync(outside, { recursive: true });
      configure(install, outside);
      const restored = resolveDesktopRuntime({}, path.join(install, 'desktop-dist/Clowder AI.exe')).instanceRoot;
      // Windows runners may supply TEMP using an 8.3 alias. Compare the actual
      // directory identity rather than requiring one spelling of the same path.
      assert.equal(fs.realpathSync.native(restored), fs.realpathSync.native(outside));
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  },
);

test('a data root containing a replaced payload is rejected before runtime creates state', () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'ancestor-boundary-'));
  try {
    const install = path.join(own, 'install');
    fs.mkdirSync(install);
    assert.throws(
      () => resolveDesktopRuntime(identity(install), path.join(install, 'desktop-dist/Clowder AI.exe')),
      /replacement boundary/i,
    );
    if (process.platform === 'win32') assert.throws(() => configure(install, install), /replacement boundary/i);
    assert.equal(fs.existsSync(path.join(install, 'desktop-instance.json')), false);
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
});

test('every recursive installer replacement/deletion is protected by the boundary matrix', () => {
  const source = fs.readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
  const entries = [...source.matchAll(/Type: filesandordirs; Name: "\{app\}\\([^"\r\n]+)"/g)];
  const declared = [...new Set(entries.map((entry) => entry[1].split('\\').join(path.sep)))].sort();
  assert.deepEqual(declared, [...replacementDirectories].sort());
});

test(
  'validate-only preserves legacy identity, history and absent client-home defaults',
  { skip: process.platform !== 'win32' },
  () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'readonly-identity-'));
    try {
      const install = path.join(own, 'install');
      const data = path.join(own, 'data');
      const legacy = path.join(install, 'desktop-dist/desktop-instance.json');
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.mkdirSync(data);
      const body = JSON.stringify(identity(data));
      fs.writeFileSync(legacy, body);
      fs.writeFileSync(path.join(data, 'history.json'), 'protected history');
      // InitializeUninstall validates the saved marker without re-requesting its root.
      configure(install, undefined, ['-ValidateOnly']);
      assert.equal(fs.readFileSync(legacy, 'utf8'), body);
      assert.deepEqual(fs.readdirSync(data), ['history.json']);
      assert.equal(fs.readFileSync(path.join(data, 'history.json'), 'utf8'), 'protected history');
      assert.equal(fs.existsSync(path.join(install, 'desktop-instance.json')), false);
      const env = { ...process.env, CAT_CAFE_DESKTOP_INSTANCE_ROOT: path.join(install, 'bundled', 'data') };
      assert.throws(() => configure(install, undefined, ['-ValidateOnly'], env), /replacement boundary/i);
      fs.writeFileSync(legacy, '{invalid');
      assert.throws(() => configure(install, undefined, ['-ValidateOnly']));
      assert.equal(fs.readFileSync(legacy, 'utf8'), '{invalid');
      assert.deepEqual(fs.readdirSync(data), ['history.json']);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  },
);

test(
  'native Inno compiles the production pre-install and read-only uninstall gates',
  { skip: process.platform !== 'win32' },
  (context) => {
    const compiler = [
      process.env.ISCC_EXE,
      'C:\\Program Files\\Inno Setup 7\\ISCC.exe',
      'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    ].find((entry) => entry && fs.existsSync(entry));
    if (!compiler) return context.skip('Requires native Inno compiler');
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-identity-gates-'));
    try {
      const helper = path.join(__dirname, 'installer/installation-identity.iss');
      const source = fs.readFileSync(helper, 'utf8');
      const uninstall = source.slice(0, source.indexOf('function PrepareToInstall'));
      assert.match(uninstall, /function InitializeUninstall/);
      assert.match(uninstall, /FileExists\(Helper\)/);
      assert.match(uninstall, /-ValidateOnly/);
      assert.match(uninstall, /Result := False/);
      assert.doesNotMatch(uninstall, /WizardForm|ExtractTemporaryFile|Write-DefaultClientHomes/);
      const script = path.join(own, 'probe.iss');
      fs.writeFileSync(
        script,
        `[Setup]
AppName=Isolated Data Boundary Compile Probe
AppVersion=1.0.0
DefaultDirName=${path.join(own, 'never-installed')}
PrivilegesRequired=lowest
OutputDir=${own}
OutputBaseFilename=compile-only
Compression=none
[Files]
Source: "${path.join(__dirname, 'scripts/configure-desktop-instance.ps1')}"; Flags: dontcopy
Source: "${path.join(__dirname, 'scripts/stop-installed-desktop.ps1')}"; Flags: dontcopy
[Code]
procedure ExtractionOutput(const S: String; const Error, FirstLine: Boolean);
begin
  Log(S);
end;
#include "${helper}"
`,
      );
      const compiled = spawnSync(compiler, ['/Q', script], {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
      });
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
      assert.equal(fs.existsSync(path.join(own, 'never-installed')), false, 'compile-only never runs Setup');
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  },
);

test(
  'an unresolved junction is never treated as an ordinary missing data directory',
  { skip: process.platform !== 'win32' },
  () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'dangling-boundary-'));
    try {
      const install = path.join(own, 'install');
      fs.mkdirSync(install);
      const alias = path.join(own, 'alias');
      fs.symlinkSync(path.join(install, 'packages'), alias, 'junction');
      const root = path.join(alias, 'future');
      assert.throws(() => resolveDesktopRuntime(identity(root), path.join(install, 'desktop-dist/Clowder AI.exe')));
      assert.throws(() => configure(install, root));
      assert.equal(fs.existsSync(path.join(install, 'desktop-instance.json')), false);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  },
);
