const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const compiler = [
  process.env.ISCC_EXE,
  'C:\\Program Files\\Inno Setup 7\\ISCC.exe',
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
].find((filename) => filename && fs.existsSync(filename));
const native = { skip: process.platform !== 'win32' || !compiler ? 'Requires Windows and native Inno' : false };
const source = fs.readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
const runtimeGuard = fs
  .readFileSync(path.join(__dirname, 'installer/runtime-failure.iss'), 'utf8')
  .match(/function RuntimeExtractionSucceeded\(\): Boolean;[\s\S]*?end;/)[0];

function writeProbe(root) {
  const run = source.match(/^\[Run\]\r?\n([\s\S]*?)(?=^\[[^\]]+\])/m)[1].replace(/\\\r?\n\s*/g, ' ');
  let hooks = 0;
  const entries = run
    .split(/\r?\n/)
    .filter((line) => /^Filename:/.test(line))
    .map((line) => {
      const application = /Filename: "\{app\}\\desktop-dist\\/.test(line);
      const label = application ? 'application-launched' : `postinstall-${hooks++}`;
      const parameters = `Parameters: "/d /c echo ${label}>>""{param:ReceiptRoot}\\actions.log"""`;
      let entry = line.replace(/^Filename: "[^"]+"/, 'Filename: "{sys}\\cmd.exe"');
      if (/Parameters:/.test(entry)) entry = entry.replace(/Parameters: "(?:""|[^"])*"/, parameters);
      else entry += `; ${parameters}`;
      return entry;
    });
  const oldSilentGate = source.match(/function ShouldAutoLaunch\(\): Boolean;[\s\S]*?end;/)?.[0] ?? '';
  const script = path.join(root, 'probe.iss');
  fs.writeFileSync(
    script,
    `#define MyAppName "PR1702 Manual Start Probe"
[Setup]
AppName={#MyAppName}
AppVersion=1.0.0
DefaultDirName=${path.join(root, 'program')}
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
UsePreviousAppDir=no
OutputDir=${root}
OutputBaseFilename=probe
Compression=none
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=no
ShowLanguageDialog=no
CloseApplications=no
RestartApplications=no
[Run]
${entries.join('\n')}
[Code]
var RuntimeFailure: String;
${runtimeGuard}
${oldSilentGate}
function PostMessage(Window: HWND; Message: Cardinal; WParam, LParam: Longint): Boolean;
  external 'PostMessageW@user32.dll stdcall';
procedure InitializeWizard;
begin
  if ExpandConstant('{param:ExtractionFailed|0}') = '1' then RuntimeFailure := 'injected incomplete extraction';
  SaveStringToFile(ExpandConstant('{param:ReceiptRoot}\\initialized.txt'), 'wizard-created', False);
  PostMessage(WizardForm.NextButton.Handle, $00F5, 0, 0);
end;
procedure CurPageChanged(PageID: Integer);
begin
  SaveStringToFile(ExpandConstant('{param:ReceiptRoot}\\pages.txt'), IntToStr(PageID) + #13#10, True);
  if PageID = wpFinished then begin
    SaveStringToFile(ExpandConstant('{param:ReceiptRoot}\\finished.txt'), IntToStr(WizardForm.RunList.Items.Count), False);
    WizardForm.NextButton.OnClick(WizardForm.NextButton);
  end else begin
    PostMessage(WizardForm.NextButton.Handle, $00F5, 0, 0);
  end;
end;
`,
    'utf8',
  );
  const compiled = spawnSync(compiler, ['/Q', script], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  return hooks;
}

function runProbe(root, mode, failed = false) {
  const receipts = path.join(root, `${mode}-${failed}`);
  fs.mkdirSync(receipts);
  const args = [
    '/SP-',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    `/ReceiptRoot=${receipts}`,
    `/LOG=${path.join(receipts, 'setup.log')}`,
    '/NoAutoStart=0',
  ];
  if (mode === 'silent') args.push('/VERYSILENT');
  if (failed) args.push('/ExtractionFailed=1');
  const ran = spawnSync(path.join(root, 'probe.exe'), args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(
    ran.status,
    0,
    ran.stdout +
      ran.stderr +
      (fs.existsSync(path.join(receipts, 'setup.log'))
        ? fs.readFileSync(path.join(receipts, 'setup.log'), 'utf8')
        : 'no pages reached'),
  );
  const actions = path.join(receipts, 'actions.log');
  const log = fs.readFileSync(path.join(receipts, 'setup.log'), 'utf8');
  if (process.env.CLOWDER_INSTALLER_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.CLOWDER_INSTALLER_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CLOWDER_INSTALLER_EVIDENCE_DIR, `${mode}-${failed}.setup.log`), log);
    const finish = path.join(receipts, 'finished.txt');
    fs.writeFileSync(
      path.join(process.env.CLOWDER_INSTALLER_EVIDENCE_DIR, `${mode}-${failed}.json`),
      JSON.stringify(
        {
          mode,
          injectedExtractionFailure: failed,
          exitCode: ran.status,
          applicationExecutions: (log.match(/echo application-launched/g) ?? []).length,
          finishedRunEntries: fs.existsSync(finish) ? Number(fs.readFileSync(finish, 'utf8')) : null,
          postinstallExecutions: (log.match(/echo postinstall-\d+/g) ?? []).length,
        },
        null,
        2,
      ),
    );
  }
  return { receipts, log, actions: fs.existsSync(actions) ? fs.readFileSync(actions, 'utf8') : '' };
}

test(
  'native production Run entries expose no application launch checkbox and never launch after interactive or silent install',
  native,
  () => {
    const base = process.env.CLOWDER_INSTALLER_TEST_ROOT || os.tmpdir();
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'pr1702-manual-start-'));
    try {
      const hooks = writeProbe(root);
      assert.ok(hooks > 0, 'real production post-install actions must remain part of the compiled probe');
      const silent = runProbe(root, 'silent');
      assert.doesNotMatch(
        silent.log,
        /echo application-launched/,
        'the native engine must not execute an application Run entry even when nowait hides its delayed marker',
      );
      assert.doesNotMatch(silent.actions, /application-launched/);
      assert.equal(silent.actions.trim().split(/\r?\n/).length, hooks);
      const interactive = runProbe(root, 'interactive');
      assert.equal(
        fs.readFileSync(path.join(interactive.receipts, 'finished.txt'), 'utf8'),
        '0',
        'the real finished page must have no application Run entry',
      );
      assert.doesNotMatch(interactive.actions, /application-launched/);
      assert.doesNotMatch(interactive.log, /echo application-launched/);
      assert.equal(interactive.actions.trim().split(/\r?\n/).length, hooks);
      for (const mode of ['interactive', 'silent']) assert.equal(runProbe(root, mode, true).actions, '');
    } finally {
      assert.equal(path.dirname(root), path.resolve(base));
      assert.match(path.basename(root), /^pr1702-manual-start-/);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
