const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runNativeCommand, withTempRoot } = require('./test-helpers/native-installer-fixture.cjs');

const compiler = [
  process.env.ISCC_EXE,
  'C:\\Program Files\\Inno Setup 7\\ISCC.exe',
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
].find((candidate) => candidate && fs.existsSync(candidate));

async function uninstallProbe(root, programs, appId) {
  // Only this probe's programs and random AppId are eligible for cleanup.
  for (const program of [...new Set(programs)].reverse()) {
    const uninstaller = path.join(program, 'unins000.exe');
    if (!fs.existsSync(uninstaller)) continue;
    const removed = await runNativeCommand(root, `uninstall-${path.basename(program)}`, uninstaller, [
      '/VERYSILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
    ]);
    assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  }
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId}_is1`;
  const remaining = spawnSync('reg.exe', ['query', key, '/reg:32'], { windowsHide: true });
  if (remaining.status === 0) execFileSync('reg.exe', ['delete', key, '/f', '/reg:32'], { windowsHide: true });
  assert.equal(fs.readFileSync(path.join(root, 'history.txt'), 'utf8'), 'persistent user history');
}

function assertExistingInstallation({ initial, selected, receipt, marker, appId, silent }) {
  assert.equal(fs.readFileSync(path.join(initial, 'desktop-instance.json'), 'utf8'), marker);
  const registration = execFileSync(
    'reg.exe',
    [
      'query',
      `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId}_is1`,
      '/v',
      'InstallLocation',
      '/reg:32',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.ok(registration.includes(initial), 'ARP must continue to point to the existing directory');
  if (selected !== initial) assert.equal(fs.existsSync(selected), false);
  if (silent) return;
  const ready = fs.readFileSync(`${receipt}.ready`, 'utf8');
  assert.ok(ready.includes(initial), 'Ready must show the existing installation path');
  assert.match(ready, /in place/);
  assert.match(ready, /uninstall.*reinstall/i);
  assert.match(ready, /configuration.*history.*personal/i);
  assert.equal(ready.split('in place').length - 1, 1, 'returning to Ready must not duplicate the explanation');
}

async function runDirectoryCase(root, { mode, hasPrevious, selectCustom, silent }) {
  const existing = hasPrevious && mode !== 'stale';
  const expectedVisited = !silent && !existing ? '1' : '0';
  const source = fs.readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
  // Omitted production directives must retain their real Inno defaults.
  const directory = source
    .split('[Setup]')[1]
    .split(/\r?\n\[/)[0]
    .split(/\r?\n/)
    .filter((line) => /^(DisableDirPage|UsePreviousAppDir)=/i.test(line))
    .join('\n');
  const directoryPolicy = /^#include "install-directory\.iss"\r?$/m.test(source)
    ? `#include "${path.join(__dirname, 'installer/install-directory.iss')}"`
    : '';
  const messages = source
    .split('[CustomMessages]')[1]
    .split('[Dirs]')[0]
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('chinese_simplified.'))
    .join('\n');
  const appId = path.basename(root);
  const initial = path.join(root, hasPrevious ? 'previous' : 'default');
  const selected = selectCustom ? path.join(root, 'custom \u5b89\u88c5\u76ee\u5f55') : initial;
  const destination = existing ? initial : selected;
  const marker = '{"CAT_CAFE_DESKTOP_INSTANCE_ROOT":"isolated-existing-data","API_SERVER_PORT":"3168"}';
  const receipt = path.join(root, 'receipt.txt');
  const script = path.join(root, 'probe.iss');
  fs.writeFileSync(path.join(root, 'payload.txt'), 'installation payload');
  fs.writeFileSync(path.join(root, 'history.txt'), 'persistent user history');
  fs.writeFileSync(
    script,
    `[Setup]
AppId=${appId}
AppName=Issue 1948 Directory Probe
AppVersion=1.0.0
DefaultDirName=${path.join(root, 'default')}
PrivilegesRequired=lowest
Uninstallable=yes
CreateUninstallRegKey=yes
DisableWelcomePage=no
DisableReadyPage=no
DisableFinishedPage=yes
DirExistsWarning=no
OutputDir=${root}
OutputBaseFilename=probe
Compression=none
${directory}
[CustomMessages]
${messages}
[Files]
Source: "${path.join(root, 'payload.txt')}"; DestDir: "{app}"
[Code]
${directoryPolicy}
var
  VisitedDirectory: Boolean;
  ReturnedFromReady: Boolean;
  PreparationFailed, ReturnedFromPreparing: Boolean;
  InitialDirectory, PreviousDirectory: String;

procedure InitializeWizard();
begin
  InitialDirectory := WizardDirValue;
  PreviousDirectory := WizardForm.PrevAppDir;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if (ExpandConstant('{param:RunId}') = 'upgrade') and not PreparationFailed then begin
    PreparationFailed := True;
    Result := 'Probe preparation failure: return to Ready and retry.';
  end;
end;

procedure CurPageChanged(PageID: Integer);
begin
  if PageID = wpPreparing then begin
    if PreparationFailed and WizardForm.BackButton.Visible and not ReturnedFromPreparing then begin
      ReturnedFromPreparing := True;
      PostMessage(WizardForm.BackButton.Handle, $00F5, 0, 0);
    end;
    exit;
  end;
  if (PageID = wpSelectDir) and not WizardSilent then begin
    VisitedDirectory := True;
    WizardForm.DirEdit.Text := ExpandConstant('{param:SelectedDir}');
  end;
  if PageID = wpReady then
    SaveStringsToUTF8File(ExpandConstant('{param:ReceiptPath}') + '.ready', [ExpandConstant('{param:RunId}'), WizardForm.ReadyMemo.Text], False);
  if (PageID = wpReady) and (ExpandConstant('{param:RunId}') = 'upgrade') and not ReturnedFromReady then begin
    ReturnedFromReady := True;
    PostMessage(WizardForm.BackButton.Handle, $00F5, 0, 0);
    exit;
  end;
  if not WizardSilent then PostMessage(WizardForm.NextButton.Handle, $00F5, 0, 0);
end;

procedure CurStepChanged(Step: TSetupStep);
begin
  if Step = ssPostInstall then
    SaveStringsToUTF8File(ExpandConstant('{param:ReceiptPath}'), [ExpandConstant('{param:RunId}'), IntToStr(Ord(VisitedDirectory)), InitialDirectory, WizardDirValue, PreviousDirectory, IntToStr(Ord(ReturnedFromPreparing))], False);
end;
`,
    'utf8',
  );
  const programs = [initial, selected];
  try {
    const compiled = await runNativeCommand(root, 'compile', compiler, ['/Q', script]);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const common = ['/SP-', '/SUPPRESSMSGBOXES', '/NORESTART'];
    if (hasPrevious) {
      const seeded = await runNativeCommand(root, 'seed', path.join(root, 'probe.exe'), [
        ...common,
        '/VERYSILENT',
        `/DIR=${initial}`,
        `/ReceiptPath=${path.join(root, 'seed-receipt.txt')}`,
        '/RunId=seed',
      ]);
      assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
      assert.equal(fs.existsSync(path.join(initial, 'unins000.exe')), true);
      fs.writeFileSync(path.join(initial, 'desktop-instance.json'), marker);
      if (mode === 'stale') {
        // Preserve the seed's uninstall registration while making its old path absent.
        fs.renameSync(initial, path.join(root, 'removed-installation'));
      }
    }
    const installed = await runNativeCommand(root, mode, path.join(root, 'probe.exe'), [
      ...common,
      `/ReceiptPath=${receipt}`,
      `/RunId=${mode}`,
      `/SelectedDir=${selected}`,
      `/LOG=${path.join(root, 'setup.log')}`,
      ...(silent ? ['/VERYSILENT'] : []),
      ...(mode === 'silent-override' ? [`/DIR=${selected}`] : []),
    ]);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const [runId, visited, defaultDirectory, actualDirectory, previousDirectory, returnedFromPreparing] = fs
      .readFileSync(receipt, 'utf8')
      .replace(/^\uFEFF/, '')
      .trim()
      .split(/\r?\n/);
    assert.equal(runId, mode, 'the receipt must come from this install, not its seed');
    assert.equal(returnedFromPreparing === '1', mode === 'upgrade', 'upgrade must return from Preparing');
    assert.equal(defaultDirectory, initial, 'upgrades must default to the previous installation');
    if (hasPrevious) assert.equal(previousDirectory, initial, 'previous directory must be available at initialization');
    assert.equal(visited, expectedVisited, 'only fresh or missing-directory installs may select a directory');
    assert.equal(actualDirectory, destination, 'existing directories must be upgraded in place');
    assert.equal(fs.readFileSync(path.join(destination, 'payload.txt'), 'utf8'), 'installation payload');
    if (existing) assertExistingInstallation({ initial, selected, receipt, marker, appId, silent });
    assert.equal(fs.readFileSync(path.join(root, 'history.txt'), 'utf8'), 'persistent user history');
  } finally {
    await uninstallProbe(root, programs, appId);
  }
}

[
  ['fresh', false, true, false],
  ['upgrade', true, false, false],
  ['stale', true, true, false],
  ['silent', true, false, true],
  ['silent-override', true, true, true],
].forEach(([mode, hasPrevious, selectCustom, silent]) => {
  test(
    `native installer directory selection: ${mode}`,
    { skip: process.platform !== 'win32' || !compiler ? 'Requires Windows and native Inno' : false },
    () =>
      withTempRoot('issue1948-directory-', (root) =>
        runDirectoryCase(root, { mode, hasPrevious, selectCustom, silent }),
      ),
  );
});
