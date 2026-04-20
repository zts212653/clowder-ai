; Clowder AI — Inno Setup Installer Script
; Builds an offline Windows .exe installer that bundles source + deps + Electron shell.
;
; Prerequisites: Inno Setup 6.x (https://jrsoftware.org/isinfo.php)
; Build:         iscc.exe desktop\installer\clowder-ai.iss
;
; The installer:
;   1. Copies pnpm-deploy output for api + web (flat hoisted node_modules,
;      real files — no Windows junctions)
;   2. Copies the pre-built Electron shell, portable Redis, and desktop assets
;   3. Optionally installs Claude/Codex/Gemini CLI tools (requires network)
;   4. Runs post-install-offline.ps1 for .env / skills setup
;   5. Creates desktop shortcut to the Electron app

#define MyAppName      "Clowder AI"
#define MyAppVersion   "0.2.0"
#define MyAppPublisher "Clowder AI"
#define MyAppURL       "https://github.com/zts212653/clowder-ai"
#define MyAppExeName   "Clowder AI.exe"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\ClowderAI
DefaultGroupName={#MyAppName}
OutputDir=..\..\dist
OutputBaseFilename=ClowderAI-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\desktop\assets\icon.ico
LicenseFile=..\..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinese_simplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Types]
Name: "full";    Description: "Full installation (all CLI tools)"
Name: "minimal"; Description: "Minimal (no extra CLI tools)"; Flags: iscustom

[Components]
Name: "core";         Description: "Clowder AI Core (required)";      Types: full minimal; Flags: fixed
Name: "cli_claude";   Description: "Claude CLI (Anthropic)";          Types: full
Name: "cli_codex";    Description: "Codex CLI (OpenAI)";              Types: full
Name: "cli_gemini";   Description: "Gemini CLI (Google)";             Types: full
Name: "cli_kimi";     Description: "Kimi CLI (Moonshot)";             Types: full

[Files]
; Deploy artifacts from `pnpm deploy` — flat, hoisted node_modules with real files.
; These supersede the old tarball + source approach. Workspace package source is
; already inlined (as real copies) inside each deploy's node_modules/@cat-cafe/*.
Source: "..\..\bundled\deploy\api\*";            DestDir: "{app}\packages\api"; \
  Flags: recursesubdirs createallsubdirs; Components: core
Source: "..\..\bundled\deploy\web\*";            DestDir: "{app}\packages\web"; \
  Flags: recursesubdirs createallsubdirs; Components: core
Source: "..\..\bundled\deploy\mcp-server\*";     DestDir: "{app}\packages\mcp-server"; \
  Flags: recursesubdirs createallsubdirs; Components: core
; cat-template.json — the authoritative source for cat model defaults.
; cat-config-loader.js resolves it relative to its own location 4 dirs up
; (= install root). Without this file, getCatModel("codex") falls back to
; the hardcoded CAT_CONFIGS default ("codex") which fox/custom proxies
; don't recognize — yielding 404 on every CLI invocation.
Source: "..\..\cat-template.json";               DestDir: "{app}"; Components: core
; Desktop scripts (post-install config generation)
Source: "..\scripts\post-install-offline.ps1";   DestDir: "{app}\scripts"; Components: core
Source: "..\scripts\generate-desktop-config.ps1"; DestDir: "{app}\scripts"; Components: core
; Electron app (pre-built via electron-builder)
Source: "..\..\desktop-dist\win-unpacked\*";     DestDir: "{app}\desktop-dist"; \
  Flags: recursesubdirs createallsubdirs; Components: core
; Desktop assets (icon used by uninstaller entry)
Source: "..\assets\*";                           DestDir: "{app}\desktop\assets"; \
  Flags: recursesubdirs createallsubdirs; Components: core
; CLI tool tarballs (optional, for offline install)
Source: "..\..\bundled\cli-tools\*";             DestDir: "{app}\bundled\cli-tools"; \
  Flags: recursesubdirs createallsubdirs skipifsourcedoesntexist; Components: core
; Portable Redis for Windows
Source: "..\..\bundled\redis\*";                 DestDir: "{app}\.cat-cafe\redis\windows"; \
  Flags: recursesubdirs createallsubdirs; Components: core

[Icons]
Name: "{group}\{#MyAppName}";        Filename: "{app}\desktop-dist\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}";  Filename: "{app}\desktop-dist\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; Enable Windows long paths — pnpm creates paths > 260 chars
Filename: "reg.exe"; \
  Parameters: "add ""HKLM\SYSTEM\CurrentControlSet\Control\FileSystem"" /v LongPathsEnabled /t REG_DWORD /d 1 /f"; \
  StatusMsg: "Enabling long path support..."; \
  Flags: runhidden waituntilterminated; Components: core
; Lightweight offline post-install
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\post-install-offline.ps1"""; \
  StatusMsg: "Configuring Clowder AI..."; \
  Flags: runhidden waituntilterminated; \
  Components: core

; Install individual CLIs if selected (requires network)
Filename: "npm.cmd"; Parameters: "install -g @anthropic-ai/claude-code"; \
  StatusMsg: "Installing Claude CLI..."; \
  Flags: runhidden waituntilterminated; Components: cli_claude
Filename: "npm.cmd"; Parameters: "install -g @openai/codex"; \
  StatusMsg: "Installing Codex CLI..."; \
  Flags: runhidden waituntilterminated; Components: cli_codex
Filename: "npm.cmd"; Parameters: "install -g @google/gemini-cli"; \
  StatusMsg: "Installing Gemini CLI..."; \
  Flags: runhidden waituntilterminated; Components: cli_gemini
Filename: "npm.cmd"; Parameters: "install -g kimi-cli"; \
  StatusMsg: "Installing Kimi CLI..."; \
  Flags: runhidden waituntilterminated; Components: cli_kimi

; Generate desktop-config.json with selected components
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -Command ""& '{app}\scripts\generate-desktop-config.ps1' -AppDir '{app}' -Claude {code:BoolComponent|cli_claude} -Codex {code:BoolComponent|cli_codex} -Gemini {code:BoolComponent|cli_gemini} -Kimi {code:BoolComponent|cli_kimi}"""; \
  StatusMsg: "Generating desktop configuration..."; \
  Flags: runhidden waituntilterminated

; Offer to launch after install
Filename: "{app}\desktop-dist\{#MyAppExeName}"; \
  Description: "Launch {#MyAppName}"; Flags: postinstall nowait skipifsilent

[Code]
function BoolComponent(Param: String): String;
begin
  if WizardIsComponentSelected(Param) then
    Result := '$true'
  else
    Result := '$false';
end;

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -Command ""Stop-Process -Name 'Clowder AI' -Force -ErrorAction SilentlyContinue"""; \
  Flags: runhidden
