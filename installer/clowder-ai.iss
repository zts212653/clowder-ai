; Clowder AI — Inno Setup Installer Script
; Builds a Windows .exe installer that bundles source + DARE + Electron shell.
;
; Prerequisites: Inno Setup 6.x (https://jrsoftware.org/isinfo.php)
; Build:         iscc.exe installer\clowder-ai.iss
;
; The installer:
;   1. Copies Clowder AI source + DARE source + pre-built Electron app
;   2. Runs install.ps1 (with -SkipCli by default)
;   3. Optionally installs Claude/Codex/Gemini/OpenCode CLIs
;   4. Creates desktop shortcut to Electron app

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
OutputDir=..\dist
OutputBaseFilename=ClowderAI-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\desktop\assets\icon.ico
LicenseFile=..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinese_simplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Types]
Name: "full";    Description: "Full installation (all CLI tools)"
Name: "minimal"; Description: "Minimal (DARE only, no extra CLI tools)"; Flags: iscustom

[Components]
Name: "core";      Description: "Clowder AI Core (required)";     Types: full minimal; Flags: fixed
Name: "dare";      Description: "DARE source code (required)";    Types: full minimal; Flags: fixed
Name: "cli_claude"; Description: "Claude CLI (Anthropic)";         Types: full
Name: "cli_codex";  Description: "Codex CLI (OpenAI)";             Types: full
Name: "cli_gemini"; Description: "Gemini CLI (Google)";             Types: full
Name: "cli_opencode"; Description: "OpenCode CLI";

[Files]
; Core source code (exclude .git, node_modules, dist, .env)
Source: "..\*";                                DestDir: "{app}"; \
  Excludes: ".git,node_modules,dist,.env,.env.local,.cat-cafe,desktop\node_modules,installer"; \
  Flags: recursesubdirs createallsubdirs; Components: core
; DARE source code (pre-copied to vendor/dare-cli/)
Source: "..\vendor\dare-cli\*";               DestDir: "{app}\vendor\dare-cli"; \
  Excludes: ".git,__pycache__,.venv";         Flags: recursesubdirs createallsubdirs; Components: dare
; Electron app (pre-built via electron-builder)
Source: "..\desktop-dist\win-unpacked\*";     DestDir: "{app}\desktop-dist"; \
  Flags: recursesubdirs createallsubdirs; Components: core

[Icons]
Name: "{group}\{#MyAppName}";        Filename: "{app}\desktop-dist\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}";  Filename: "{app}\desktop-dist\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; Run install.ps1 after file copy. CLI flags are conditional on selected components.
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -File ""{app}\scripts\install.ps1"" -SkipCli"; \
  StatusMsg: "Setting up Clowder AI (Node.js, Redis, dependencies)..."; \
  Flags: runhidden waituntilterminated; \
  Components: core

; Install individual CLIs if selected
Filename: "npm.cmd"; Parameters: "install -g @anthropic-ai/claude-code"; \
  StatusMsg: "Installing Claude CLI..."; \
  Flags: runhidden waituntilterminated; Components: cli_claude
Filename: "npm.cmd"; Parameters: "install -g @openai/codex"; \
  StatusMsg: "Installing Codex CLI..."; \
  Flags: runhidden waituntilterminated; Components: cli_codex
Filename: "npm.cmd"; Parameters: "install -g @google/gemini-cli"; \
  StatusMsg: "Installing Gemini CLI..."; \
  Flags: runhidden waituntilterminated; Components: cli_gemini
Filename: "npm.cmd"; Parameters: "install -g @anthropic-ai/opencode"; \
  StatusMsg: "Installing OpenCode CLI..."; \
  Flags: runhidden waituntilterminated; Components: cli_opencode

; Generate desktop-config.json with selected components
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -Command ""& '{app}\scripts\generate-desktop-config.ps1' -AppDir '{app}' -Claude {code:BoolComponent|cli_claude} -Codex {code:BoolComponent|cli_codex} -Gemini {code:BoolComponent|cli_gemini} -OpenCode {code:BoolComponent|cli_opencode}"""; \
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
