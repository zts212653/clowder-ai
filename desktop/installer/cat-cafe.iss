; Cat Cafe — Inno Setup Installer Script
; Builds an offline Windows .exe installer that bundles source + deps + Electron shell.
;
; Prerequisites: Inno Setup 6.x (https://jrsoftware.org/isinfo.php)
; Build:         iscc.exe desktop\installer\cat-cafe.iss
;
; The installer:
;   1. Ships bulk tar.gz archives (deploy packages, Electron, Node.js)
;      instead of 30K+ individual files — eliminates per-file NTFS + Defender
;      overhead that caused 10+ min installs
;   2. Extracts archives post-install using Windows' built-in tar.exe
;   3. Copies small files directly (skills, docs, scripts, Redis)
;   4. Runs post-install-offline.ps1 for .env / skills setup
;   5. Runs user-level Agent CLI hook sync under the invoking user profile
;   6. Creates desktop shortcut to the Electron app

#define MyAppName      "Cat Cafe"
; MyAppVersion can be overridden by iscc /DMyAppVersion=X.Y.Z (CI release pipeline).
; Default kept for local manual builds.
#ifndef MyAppVersion
  #define MyAppVersion "0.10.1"
#endif
#define MyAppPublisher "Cat Cafe"
#define MyAppURL       "https://github.com/zts212653/cat-cafe"
#define MyAppExeName   "Cat Cafe.exe"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
; Show just "Cat Cafe" in Add/Remove Programs, not "Cat Cafe 版本 X.Y.Z".
; The version is still available in the detail pane via AppVersion.
AppVerName={#MyAppName}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\CatCafe
DefaultGroupName={#MyAppName}
OutputDir=..\..\dist
OutputBaseFilename=CatCafe-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; Always create a setup log (%TEMP%\Setup Log *.txt) for post-mortem debugging.
SetupLogging=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\desktop\assets\icon.ico
LicenseFile=..\..\LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinese_simplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Dirs]
; Target directories for tar.exe archive extraction ([Run] section).
; Must exist before tar -C writes into them.
Name: "{app}\packages\api"
Name: "{app}\packages\web"
Name: "{app}\packages\mcp-server"
Name: "{app}\desktop-dist"
Name: "{app}\node"

[Files]
; ── Bulk archives ─────────────────────────────────────────────────────
; Shipped as tar.gz and extracted post-install by Windows' built-in tar.exe.
; This replaces per-file Inno Setup extraction of 30K+ node_modules files,
; eliminating per-file NTFS + Defender overhead (10+ min → <2 min install).
Source: "..\..\bundled\archives\deploy-api.tar.gz";        DestDir: "{app}\bundled\archives"
Source: "..\..\bundled\archives\deploy-web.tar.gz";        DestDir: "{app}\bundled\archives"
Source: "..\..\bundled\archives\deploy-mcp-server.tar.gz"; DestDir: "{app}\bundled\archives"
Source: "..\..\bundled\archives\electron.tar.gz";           DestDir: "{app}\bundled\archives"
Source: "..\..\bundled\archives\node.tar.gz";               DestDir: "{app}\bundled\archives"
; ── Individual files (small — per-file overhead negligible) ───────────
; cat-template.json — the authoritative source for cat model defaults.
; cat-config-loader.js resolves it relative to its own location 4 dirs up
; (= install root). Without this file, getCatModel("codex") falls back to
; the hardcoded CAT_CONFIGS default ("codex") which fox/custom proxies
; don't recognize — yielding 404 on every CLI invocation.
Source: "..\..\cat-template.json";               DestDir: "{app}"
; Repository structure so findMonorepoRoot() resolves correctly at install root.
; Without pnpm-workspace.yaml at {app}, the monorepo marker walks above Program
; Files, which breaks docs/skills/package resolution paths in the API.
Source: "..\..\pnpm-workspace.yaml";             DestDir: "{app}"
Source: "..\..\package.json";                    DestDir: "{app}"
; Skills manifest — loaded by API routes/capabilities.ts when listing available
; skills. Missing → skills panel shows empty; cats lose skill context.
Source: "..\..\cat-cafe-skills\*";               DestDir: "{app}\cat-cafe-skills"; \
  Flags: recursesubdirs createallsubdirs
; Documentation directories used by git-doc-reader and feat-index-doc-import
; routes (features, threads, architecture). Missing → /api/docs/* returns 404.
Source: "..\..\docs\*";                          DestDir: "{app}\docs"; \
  Flags: recursesubdirs createallsubdirs
; Runtime scripts — blacklist approach: include all scripts, exclude platform-
; irrelevant and dev artifacts. New files are automatically included without
; needing to update this manifest (prevents the "missing file" class of bugs).
; Excludes: *.sh (bash — Linux/Mac only), *.test.* (test files), __pycache__
Source: "..\..\scripts\*";                         DestDir: "{app}\scripts"; \
  Excludes: "*.sh,*.test.*,__pycache__"; \
  Flags: recursesubdirs createallsubdirs
; L0 system prompt template — read by rules.ts for governance compilation.
Source: "..\..\assets\system-prompts\*";           DestDir: "{app}\assets\system-prompts"; \
  Flags: recursesubdirs createallsubdirs
; Guide registry + flow definitions — loaded by guide-registry-loader.ts.
; Missing → bootcamp/guide features crash on first request.
Source: "..\..\guides\*";                          DestDir: "{app}\guides"; \
  Flags: recursesubdirs createallsubdirs
; (Node.js runtime is shipped as node.tar.gz in bulk archives above)
; Desktop scripts (post-install config generation)
Source: "..\scripts\post-install-offline.ps1";   DestDir: "{app}\scripts"
Source: "..\scripts\generate-desktop-config.ps1"; DestDir: "{app}\scripts"
Source: "..\scripts\sync-agent-hooks-offline.mjs"; DestDir: "{app}\scripts"
; User-level Agent CLI hook truth source used by F180 health/sync.
Source: "..\..\.claude\hooks\user-level\*";      DestDir: "{app}\.claude\hooks\user-level"; \
  Flags: recursesubdirs createallsubdirs
; (Electron app is shipped as electron.tar.gz in bulk archives above)
; Desktop assets (icon used by uninstaller entry)
Source: "..\assets\*";                           DestDir: "{app}\desktop\assets"; \
  Flags: recursesubdirs createallsubdirs
; Portable Redis for Windows
Source: "..\..\bundled\redis\*";                 DestDir: "{app}\.cat-cafe\redis\windows"; \
  Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}";        Filename: "{app}\desktop-dist\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}";  Filename: "{app}\desktop-dist\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; ── Extract bulk archives (tar.exe built into Windows 10 1803+) ───────
; Full {sys} path ensures System32\tar.exe is found regardless of WoW64 state.
Filename: "{sys}\tar.exe"; \
  Parameters: "-xzf ""{app}\bundled\archives\deploy-api.tar.gz"" -C ""{app}\packages\api"""; \
  StatusMsg: "Extracting API runtime..."; \
  Flags: runhidden waituntilterminated
Filename: "{sys}\tar.exe"; \
  Parameters: "-xzf ""{app}\bundled\archives\deploy-web.tar.gz"" -C ""{app}\packages\web"""; \
  StatusMsg: "Extracting Web runtime..."; \
  Flags: runhidden waituntilterminated
Filename: "{sys}\tar.exe"; \
  Parameters: "-xzf ""{app}\bundled\archives\deploy-mcp-server.tar.gz"" -C ""{app}\packages\mcp-server"""; \
  StatusMsg: "Extracting MCP Server..."; \
  Flags: runhidden waituntilterminated
Filename: "{sys}\tar.exe"; \
  Parameters: "-xzf ""{app}\bundled\archives\electron.tar.gz"" -C ""{app}\desktop-dist"""; \
  StatusMsg: "Extracting Electron shell..."; \
  Flags: runhidden waituntilterminated
Filename: "{sys}\tar.exe"; \
  Parameters: "-xzf ""{app}\bundled\archives\node.tar.gz"" -C ""{app}\node"""; \
  StatusMsg: "Extracting Node.js runtime..."; \
  Flags: runhidden waituntilterminated
; Create scripts/node_modules junction → packages/api/node_modules.
; compile-system-prompt-l0.mjs uses ESM imports (@cat-cafe/shared) which
; require a filesystem node_modules chain (NODE_PATH is ignored by ESM).
; Must be done during install (admin context) — Program Files is read-only
; at runtime, so the desktop app cannot create junctions there.
Filename: "cmd.exe"; \
  Parameters: "/c mklink /J ""{app}\scripts\node_modules"" ""{app}\packages\api\node_modules"""; \
  StatusMsg: "Linking script dependencies..."; \
  Flags: runhidden waituntilterminated
; Clean up archives after extraction (saves ~100 MB disk space)
Filename: "cmd.exe"; \
  Parameters: "/c rmdir /s /q ""{app}\bundled\archives"""; \
  StatusMsg: "Cleaning up temporary files..."; \
  Flags: runhidden waituntilterminated
; ── Post-install configuration ────────────────────────────────────────
; Enable Windows long paths — pnpm creates paths > 260 chars
Filename: "reg.exe"; \
  Parameters: "add ""HKLM\SYSTEM\CurrentControlSet\Control\FileSystem"" /v LongPathsEnabled /t REG_DWORD /d 1 /f"; \
  StatusMsg: "Enabling long path support..."; \
  Flags: runhidden waituntilterminated
; Post-install: .env, skills, agent hooks.
; CLI tool provisioning removed — bundled Node has no global npm, so
; `npm install -g` fails on clean machines. Users install CLIs separately.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\post-install-offline.ps1"" -AppDir ""{app}"""; \
  StatusMsg: "Configuring Cat Cafe..."; \
  Flags: runhidden waituntilterminated
; User-level Agent CLI hook sync writes to ~/.claude and ~/.codex, so it must
; run as the invoking user rather than the elevated installer account.
; If Windows cannot recover the original credentials, Hub health check repairs it later.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\post-install-offline.ps1"" -AppDir ""{app}"" -AgentHooksOnly"; \
  StatusMsg: "Configuring Agent CLI hooks..."; \
  Flags: runhidden waituntilterminated runasoriginaluser

; Generate desktop-config.json
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -Command ""& '{app}\scripts\generate-desktop-config.ps1' -AppDir '{app}'"""; \
  StatusMsg: "Generating desktop configuration..."; \
  Flags: runhidden waituntilterminated

; Offer to launch after install
Filename: "{app}\desktop-dist\{#MyAppExeName}"; \
  Description: "Launch {#MyAppName}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -Command ""Stop-Process -Name 'Cat Cafe' -Force -ErrorAction SilentlyContinue"""; \
  Flags: runhidden

[UninstallDelete]
; Directories created by tar.exe extraction are not tracked by Inno Setup's
; built-in file registry — must be explicitly listed for clean removal.
Type: filesandordirs; Name: "{app}\packages"
Type: filesandordirs; Name: "{app}\desktop-dist"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\bundled"
; scripts/node_modules junction created by mklink /J in [Run]
Type: filesandordirs; Name: "{app}\scripts\node_modules"
