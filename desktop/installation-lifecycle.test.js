const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { spawn, execFileSync } = require('node:child_process');
const { createWindowRecoveryController } = require('./window-recovery');

test('second-instance shutdown accepts only the same installation and user-data identity', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf("app.on('second-instance'");
  const end = source.indexOf("\napp.on('ready'", start);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-identity-'));
  try {
    const root = path.join(base, 'install');
    const userData = path.join(base, 'instance');
    fs.mkdirSync(root);
    fs.mkdirSync(userData);
    let handler,
      quits = 0;
    const context = {
      app: {
        on: (_name, callback) => {
          handler = callback;
        },
        getPath: () => userData,
      },
      PROJECT_ROOT: root,
      QUIT_FOR_UPDATE_ARG: '--quit-owned-installation',
      dbg: () => {},
      quitApp: () => {
        quits++;
      },
      windowRecovery: createWindowRecoveryController({
        getState: () => ({ phase: 'ready', mainWindow: null, splashWindow: null, services: null, isQuitting: false }),
        createMainWindow: async () => {},
        quitArg: '--quit-owned-installation',
        isShutdownRequest: (...args) => require('./installation-lifecycle').isInstallationShutdownRequest(...args),
        projectRoot: root,
        getUserDataRoot: () => userData,
        quitApp: () => {
          quits++;
        },
        dbg: () => {},
      }),
    };
    vm.runInNewContext(source.slice(start, end), context);
    const args = ['exe', '--quit-owned-installation'];
    handler(null, args, '', { installRoot: path.join(base, 'other'), userDataRoot: userData });
    handler(null, args, '', { installRoot: root, userDataRoot: path.join(base, 'other-data') });
    handler(null, args, '', undefined);
    handler(null, ['exe', '--quit-for-update'], '', { installRoot: root, userDataRoot: userData });
    assert.equal(quits, 0, 'foreign or missing identity cannot shut down this app');
    handler(null, ['exe', '--quit-owned-installation'], '', { installRoot: root, userDataRoot: userData });
    assert.equal(quits, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('second-instance renderer recreation reports failures instead of creating an unhandled rejection', async () => {
  const failure = new Error('controlled renderer load failure');
  let reported;
  const controller = createWindowRecoveryController({
    getState: () => ({ phase: 'ready', mainWindow: null, splashWindow: null, services: {}, isQuitting: false }),
    createMainWindow: async () => {
      throw failure;
    },
    quitArg: '--quit-owned-installation',
    isShutdownRequest: () => false,
    projectRoot: '/tmp/install',
    getUserDataRoot: () => '/tmp/user-data',
    quitApp: () => {},
    dbg: () => {},
    onRecoveryError: (error) => {
      reported = error;
    },
  });
  controller.handleSecondInstance(['clowder-ai.exe'], undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reported, failure);
});

test(
  'Windows cleanup stops a test-owned install process and preserves its sibling control',
  { skip: process.platform !== 'win32' },
  async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-stop-'));
    const root = path.join(base, 'install');
    const sibling = path.join(base, 'install-other');
    const children = [];
    try {
      for (const dir of [root, sibling]) {
        fs.mkdirSync(dir);
        const executable = path.join(dir, 'probe.exe');
        fs.copyFileSync(process.execPath, executable);
        const child = spawn(executable, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        children.push(child);
      }
      const script = path.join(__dirname, 'scripts/stop-installed-desktop.ps1');
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-AppDir', root];
      assert.equal(
        JSON.parse(execFileSync('powershell.exe', [...args, '-InspectOnly'], { encoding: 'utf8' }).trim()),
        children[0].pid,
      );
      const alias = path.join(base, 'alias');
      fs.symlinkSync(root, alias, 'junction');
      assert.equal(
        JSON.parse(
          execFileSync('powershell.exe', [...args.slice(0, -1), alias, '-InspectOnly'], { encoding: 'utf8' }).trim(),
        ),
        children[0].pid,
      );
      execFileSync('powershell.exe', [...args, '-WaitSeconds', '0'], { timeout: 10000 });
      await new Promise((resolve) => {
        if (children[0].exitCode !== null) resolve();
        else children[0].once('exit', resolve);
      });
      assert.doesNotThrow(() => process.kill(children[1].pid, 0), 'sibling installation remains running');
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve)),
        ),
      );
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
);

test('installer and uninstaller use the same installation-scoped shutdown script', () => {
  const installer = fs.readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
  assert.doesNotMatch(installer, /Stop-Process -Name/);
  assert.match(installer, /\[UninstallRun\][\s\S]*stop-installed-desktop\.ps1/);
  assert.match(installer, /PrepareToInstall[\s\S]*stop-installed-desktop\.ps1/);
  const script = fs.readFileSync(path.join(__dirname, 'scripts/stop-installed-desktop.ps1'), 'utf8');
  assert.match(script, /StartsWith\(\$installPrefix, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(script, /--quit-owned-installation/);
  assert.doesNotMatch(script, /ArgumentList '--quit-for-update'/);
  const outgoing = script.match(/ArgumentList '([^']+)'/)[1];
  assert.equal(
    ['exe', outgoing].includes('--quit-for-update'),
    false,
    'old receiver cannot interpret the new request as legacy quit',
  );
  assert.doesNotMatch(script, /Stop-Process -Name/);
});

test('post-install launch runs as the original user after an elevated installation', () => {
  const installer = fs.readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
  const launch = installer.match(
    /; Offer to launch after interactive install[\s\S]*?Description: "Launch \{#MyAppName\}";[^\r\n]+/,
  );
  assert.ok(launch, 'production installer must keep a post-install launch entry');
  assert.match(launch[0], /Flags: postinstall nowait skipifsilent runasoriginaluser/);
});

test('installer uses the Windows Program Files default and does not bake a truncated path', () => {
  const installer = fs.readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
  assert.match(installer, /DefaultDirName=\{autopf\}\\ClowderAI/);
  assert.doesNotMatch(installer, /DefaultDirName=.*C:\\Program(?:\\|$)/i);
});

test('isolated install records host client homes without copying credentials', () => {
  const script = fs.readFileSync(path.join(__dirname, 'scripts/configure-desktop-instance.ps1'), 'utf8');
  assert.match(script, /client-homes\.json/);
  for (const key of ['claude', 'codex', 'dsh', 'kimi', 'pi']) assert.match(script, new RegExp(`\\b${key}\\s*=`));
  assert.match(script, /Test-Path -LiteralPath \$target/);
  assert.match(script, /Move-Item -LiteralPath \$temporary -Destination \$target/);
  assert.doesNotMatch(script, /Copy-Item[^\r\n]+\.credentials|auth\.json/);
});
