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

[
  ['fresh', false, true],
  ['upgrade', true, false],
  ['relocate', true, true],
  ['silent', true, false],
].forEach(([mode, hasPrevious, selectCustom]) => {
  const silentArguments = mode === 'silent' ? ['/VERYSILENT'] : [];
  const expectedVisited = mode === 'silent' ? '0' : '1';
  test(
    `native installer directory selection: ${mode}`,
    { skip: process.platform !== 'win32' || !compiler ? 'Requires Windows and native Inno' : false },
    async () => {
      await withTempRoot('issue1948-directory-', async (root) => {
        const source = fs.readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
        // Omitted production directives must retain their real Inno defaults.
        const directory = source
          .split('[Setup]')[1]
          .split(/\r?\n\[/)[0]
          .split(/\r?\n/)
          .filter((line) => /^(DisableDirPage|UsePreviousAppDir)=/i.test(line))
          .join('\n');
        const appId = path.basename(root);
        const initial = path.join(root, hasPrevious ? 'previous' : 'default');
        const selected = selectCustom ? path.join(root, 'custom \u5b89\u88c5\u76ee\u5f55') : initial;
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
DisableWelcomePage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
DirExistsWarning=no
OutputDir=${root}
OutputBaseFilename=probe
Compression=none
${directory}
[Files]
Source: "${path.join(root, 'payload.txt')}"; DestDir: "{app}"
[Code]
var
  VisitedDirectory: Boolean;
  InitialDirectory: String;

procedure InitializeWizard();
begin
  InitialDirectory := WizardDirValue;
end;

procedure CurPageChanged(PageID: Integer);
begin
  if (PageID = wpSelectDir) and not WizardSilent then begin
    VisitedDirectory := True;
    WizardForm.DirEdit.Text := ExpandConstant('{param:SelectedDir}');
  end;
  if not WizardSilent then PostMessage(WizardForm.NextButton.Handle, $00F5, 0, 0);
end;

procedure CurStepChanged(Step: TSetupStep);
begin
  if Step = ssPostInstall then
    SaveStringsToUTF8File(ExpandConstant('{param:ReceiptPath}'), [ExpandConstant('{param:RunId}'), IntToStr(Ord(VisitedDirectory)), InitialDirectory, WizardDirValue], False);
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
          }
          const installed = await runNativeCommand(root, mode, path.join(root, 'probe.exe'), [
            ...common,
            `/ReceiptPath=${receipt}`,
            `/RunId=${mode}`,
            `/SelectedDir=${selected}`,
            `/LOG=${path.join(root, 'setup.log')}`,
            ...silentArguments,
          ]);
          assert.equal(installed.status, 0, installed.stdout + installed.stderr);
          const [runId, visited, defaultDirectory, actualDirectory] = fs
            .readFileSync(receipt, 'utf8')
            .replace(/^\uFEFF/, '')
            .trim()
            .split(/\r?\n/);
          assert.equal(runId, mode, 'the receipt must come from this install, not its seed');
          assert.equal(defaultDirectory, initial, 'upgrades must default to the previous installation');
          assert.equal(visited, expectedVisited, 'interactive upgrades must show the directory page');
          assert.equal(actualDirectory, selected, 'the directory edit must control the actual installation');
          assert.equal(fs.readFileSync(path.join(selected, 'payload.txt'), 'utf8'), 'installation payload');
          if (mode === 'relocate') assert.equal(fs.existsSync(path.join(initial, 'payload.txt')), true);
          assert.equal(fs.readFileSync(path.join(root, 'history.txt'), 'utf8'), 'persistent user history');
        } finally {
          await uninstallProbe(root, programs, appId);
        }
      });
    },
  );
});
