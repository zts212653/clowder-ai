const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const compiler = [
  process.env.ISCC_EXE,
  'C:\\Program Files\\Inno Setup 7\\ISCC.exe',
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
].find((candidate) => candidate && existsSync(candidate));

test(
  'native Inno engine honors NOICONS while preserving normal Start Menu defaults',
  {
    skip: process.platform !== 'win32' || !compiler ? 'Requires Windows and the native Inno compiler' : false,
  },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pr1519-no-icons-'));
    try {
      const source = readFileSync(path.join(__dirname, 'installer/cat-cafe.iss'), 'utf8');
      const setup = source.split('[Setup]')[1].split(/\r?\n\[/)[0];
      // Consume the production Start Menu directives, including omitted/default values.
      // No Icons entries or uninstaller: this probe cannot create system shortcuts.
      const menu = setup
        .split(/\r?\n/)
        .filter((line) =>
          /^(DefaultGroupName|AllowNoIcons|DisableProgramGroupPage|UsePreviousGroup|AlwaysUsePersonalGroup|AppendDefaultGroupName)=/i.test(
            line,
          ),
        )
        .map((line) => line.replaceAll('{#MyAppName}', 'PR1519 Engine Probe'))
        .join('\n');
      const script = path.join(root, 'probe.iss');
      writeFileSync(
        script,
        `[Setup]
AppName=PR1519 Engine Probe
AppVersion=1.0.0
DefaultDirName={tmp}\\PR1519 Engine Probe
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
UsePreviousAppDir=no
OutputDir=${root}
OutputBaseFilename=probe
Compression=none
${menu}
[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    if WizardNoIcons then
      SaveStringToFile(ExpandConstant('{param:ReceiptPath}'), 'true', False)
    else
      SaveStringToFile(ExpandConstant('{param:ReceiptPath}'), 'false', False);
  end;
end;
`,
        'utf8',
      );
      const compiled = spawnSync(compiler, ['/Q', script], { encoding: 'utf8', timeout: 30000 });
      assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
      for (const noIcons of [false, true]) {
        const receipt = path.join(root, `${noIcons}.txt`);
        const args = ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/ReceiptPath=${receipt}`];
        if (noIcons) args.push('/NOICONS');
        const installed = spawnSync(path.join(root, 'probe.exe'), args, { encoding: 'utf8', timeout: 30000 });
        assert.equal(installed.status, 0, installed.stdout + installed.stderr);
        assert.equal(readFileSync(receipt, 'utf8'), String(noIcons), `WizardNoIcons must honor /NOICONS=${noIcons}`);
      }
    } finally {
      const parent = path.resolve(tmpdir()) + path.sep;
      assert.ok(path.resolve(root).startsWith(parent) && path.basename(root).startsWith('pr1519-no-icons-'));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
