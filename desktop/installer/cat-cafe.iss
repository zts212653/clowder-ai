; Clowder AI — Inno Setup Installer Script
; Builds an offline Windows .exe installer that bundles source + deps + Electron shell.
;
; Prerequisites: Inno Setup 6.x (https://jrsoftware.org/isinfo.php)
; Build:         iscc.exe desktop\installer\cat-cafe.iss
;
; The installer:
;   1. Ships bulk tar.gz archives (deploy packages, Electron, Node.js)
;      plus a single frozen shared dependency tree, without duplicate shell resources.
;   2. Extracts Node with system tar, then runtime archives with bundled npm tar,
;      integrity manifests, live progress and diagnostic heartbeats.
;   3. Copies small files directly (skills, docs, scripts, Redis)
;   4. Runs post-install-offline.ps1 for .env / skills setup
;   5. Runs user-level Agent CLI hook sync under the invoking user profile
;   6. Creates desktop shortcut to the Electron app

#define MyAppName      "Clowder AI Intranet"
; MyAppVersion can be overridden by iscc /DMyAppVersion=X.Y.Z (CI release pipeline).
; Default kept for local manual builds.
#ifndef MyAppVersion
  #define MyAppVersion "1.14.0"
#endif
#define MyAppPublisher "Clowder AI"
#define MyAppURL       "https://github.com/zts212653/clowder-ai"
#define MyAppExeName   "Clowder AI.exe"
#define MyAppUserModelID "ai.clowderai.intranet"
#ifndef MyAppId
  #define MyAppId "{{CAEEDC72-2026-4AC0-9D9C-0FCB0ADEA611}"
#endif

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
; Show just "Clowder AI" in Add/Remove Programs, not "Clowder AI 版本 X.Y.Z".
; The version is still available in the detail pane via AppVersion.
AppVerName={#MyAppName}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\ClowderAI-Intranet
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=..\..\dist
OutputBaseFilename=ClowderAI-Intranet-Setup-{#MyAppVersion}
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
; Runtime extraction still creates files; actual install timings must be measured.
Source: "..\scripts\extract-runtime-archive.cjs"; DestDir: "{app}\scripts"
Source: "..\scripts\native-runtime-extractor.cjs"; DestDir: "{app}\scripts"
Source: "..\..\bundled\archives\deploy-dependencies.tar.gz.json"; DestDir: "{app}\bundled\archives"
Source: "..\..\bundled\archives\deploy-api.tar.gz.json"; DestDir: "{app}\bundled\archives"
Source: "..\..\bundled\archives\deploy-web.tar.gz.json"; DestDir: "{app}\bundled\archives"
Source: "..\..\bundled\archives\deploy-mcp-server.tar.gz.json"; DestDir: "{app}\bundled\archives"
Source: "..\..\bundled\archives\electron.tar.gz.json"; DestDir: "{app}\bundled\archives"
; Already compressed: copying these verbatim avoids a second compression/decode layer.
Source: "..\..\bundled\archives\node.tar.gz"; DestDir: "{app}\bundled\archives"; Flags: nocompression; AfterInstall: ExtractRuntimeArchive('node.tar.gz')
Source: "..\..\bundled\archives\deploy-dependencies.tar.gz"; DestDir: "{app}\bundled\archives"; Flags: nocompression; AfterInstall: ExtractRuntimeArchive('deploy-dependencies.tar.gz')
Source: "..\..\bundled\archives\deploy-api.tar.gz"; DestDir: "{app}\bundled\archives"; Flags: nocompression; AfterInstall: ExtractRuntimeArchive('deploy-api.tar.gz')
Source: "..\..\bundled\archives\deploy-web.tar.gz"; DestDir: "{app}\bundled\archives"; Flags: nocompression; AfterInstall: ExtractRuntimeArchive('deploy-web.tar.gz')
Source: "..\..\bundled\archives\deploy-mcp-server.tar.gz"; DestDir: "{app}\bundled\archives"; Flags: nocompression; AfterInstall: ExtractRuntimeArchive('deploy-mcp-server.tar.gz')
Source: "..\..\bundled\archives\electron.tar.gz"; DestDir: "{app}\bundled\archives"; Flags: nocompression; AfterInstall: ExtractRuntimeArchive('electron.tar.gz')
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
; Git checks out this symlink as a four-byte "refs" file on Windows.  Do not
; let Inno replace an existing installed alias directory with that file (it
; fails with MoveFile error 183 on upgrade).  The explicit entry below keeps
; the runtime alias directory and its relative skill references intact.
Source: "..\..\cat-cafe-skills\*";               DestDir: "{app}\cat-cafe-skills"; \
  Excludes: ".cat-cafe-shared-refs*"; \
  Flags: recursesubdirs createallsubdirs
Source: "..\..\cat-cafe-skills\refs\*";         DestDir: "{app}\cat-cafe-skills\.cat-cafe-shared-refs"; \
  Flags: recursesubdirs createallsubdirs
; Documentation directories used by git-doc-reader and feat-index-doc-import
; routes (features, threads, architecture). Missing → /api/docs/* returns 404.
Source: "..\..\docs\*";                          DestDir: "{app}\docs"; \
  Flags: recursesubdirs createallsubdirs
; Runtime scripts — blacklist approach: include all scripts, exclude platform-
; irrelevant and dev artifacts. New files are automatically included without
; needing to update this manifest (prevents the "missing file" class of bugs).
; scripts/node_modules can be a development junction into the entire workspace.
; Runtime dependencies are supplied by the frozen archive and install-time link.
Source: "..\..\scripts\*";                         DestDir: "{app}\scripts"; \
  Excludes: "*.sh,*.test.*,__pycache__,node_modules"; \
  Flags: recursesubdirs createallsubdirs
; Runtime assets — prompt templates, manifest, system prompt, brand dictionary.
Source: "..\..\assets\*";                          DestDir: "{app}\assets"; \
  Flags: recursesubdirs createallsubdirs
; Guide registry + flow definitions — loaded by guide-registry-loader.ts.
; Missing → bootcamp/guide features crash on first request.
Source: "..\..\guides\*";                          DestDir: "{app}\guides"; \
  Flags: recursesubdirs createallsubdirs
; (Node.js runtime is shipped as node.tar.gz in bulk archives above)
; Desktop scripts (post-install config generation)
Source: "..\scripts\post-install-offline.ps1";   DestDir: "{app}\scripts"
Source: "..\scripts\configure-desktop-instance.ps1"; DestDir: "{app}\scripts"
Source: "..\scripts\configure-desktop-instance.ps1"; Flags: dontcopy
Source: "..\scripts\stop-installed-desktop.ps1"; DestDir: "{app}\scripts"
Source: "..\scripts\generate-desktop-config.ps1"; DestDir: "{app}\scripts"
Source: "..\scripts\sync-agent-hooks-offline.mjs"; DestDir: "{app}\scripts"
; User-level Agent CLI hook truth source used by F180 health/sync.
Source: "..\..\.claude\hooks\user-level\*";      DestDir: "{app}\.claude\hooks\user-level"; \
  Flags: recursesubdirs createallsubdirs
; #1542: canonical Node compaction carrier packaged for spawn-time --settings injection.
Source: "..\..\.claude\hooks\f24-compaction.mjs"; DestDir: "{app}\.claude\hooks"
; (Electron app is shipped as electron.tar.gz in bulk archives above)
; Desktop assets (icon used by uninstaller entry)
Source: "..\assets\*";                           DestDir: "{app}\desktop\assets"; \
  Flags: recursesubdirs createallsubdirs
; Portable Redis for Windows — fail-closed: any publishable installer MUST
; include Redis. The build script retries download 3× and verifies
; redis-server.exe; Inno Setup will abort here if bundled/redis/ is empty.
Source: "..\..\bundled\redis\*";                 DestDir: "{app}\.cat-cafe\redis\windows"; \
  Flags: recursesubdirs createallsubdirs

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Icons]
Name: "{group}\{#MyAppName}";        Filename: "{app}\desktop-dist\{#MyAppExeName}"; AppUserModelID: "{#MyAppUserModelID}"
Name: "{autodesktop}\{#MyAppName}";  Filename: "{app}\desktop-dist\{#MyAppExeName}"; AppUserModelID: "{#MyAppUserModelID}"; Tasks: desktopicon
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; ── Extract bulk archives (tar.exe built into Windows 10 1803+) ───────
; Full {sys} path ensures System32\tar.exe is found regardless of WoW64 state.
; Create scripts/node_modules junction → packages/api/node_modules.
; compile-system-prompt-l0.mjs uses ESM imports (@cat-cafe/shared) which
; require a filesystem node_modules chain (NODE_PATH is ignored by ESM).
; Must be done during install (admin context) — Program Files is read-only
; at runtime, so the desktop app cannot create junctions there.
Filename: "cmd.exe"; \
  Parameters: "/c mklink /J ""{app}\scripts\node_modules"" ""{app}\packages\api\node_modules"""; \
  StatusMsg: "Linking script dependencies..."; \
  Flags: runhidden waituntilterminated; Check: RuntimeExtractionSucceeded
; Clean up archives after extraction (saves ~100 MB disk space)
Filename: "cmd.exe"; \
  Parameters: "/c rmdir /s /q ""{app}\bundled\archives"""; \
  StatusMsg: "Cleaning up temporary files..."; \
  Flags: runhidden waituntilterminated; Check: RuntimeExtractionSucceeded
; ── Post-install configuration ────────────────────────────────────────
; Enable Windows long paths — pnpm creates paths > 260 chars
Filename: "reg.exe"; \
  Parameters: "add ""HKLM\SYSTEM\CurrentControlSet\Control\FileSystem"" /v LongPathsEnabled /t REG_DWORD /d 1 /f"; \
  StatusMsg: "Enabling long path support..."; \
  Flags: runhidden waituntilterminated; Check: RuntimeExtractionSucceeded
; Post-install: .env, skills, agent hooks.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\configure-desktop-instance.ps1"" -AppDir ""{app}"" -InstanceRoot ""{param:DesktopInstanceRoot|}"" -FrontendPort ""{param:FrontendPort|}"" -ApiPort ""{param:ApiPort|}"" -RedisPort ""{param:RedisPort|}"""; \
  StatusMsg: "Configuring desktop instance..."; \
  Flags: runhidden waituntilterminated; Check: RuntimeExtractionSucceeded
; CLI tool provisioning removed — bundled Node has no global npm, so
; `npm install -g` fails on clean machines. Users install CLIs separately.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\post-install-offline.ps1"" -AppDir ""{app}"" -UserProfileRoot ""{param:UserProfileRoot|}"""; \
  StatusMsg: "Configuring Clowder AI..."; \
  Flags: runhidden waituntilterminated; Check: RuntimeExtractionSucceeded
; User-level Agent CLI hook sync writes to ~/.claude and ~/.codex, so it must
; run as the invoking user rather than the elevated installer account.
; If Windows cannot recover the original credentials, Hub health check repairs it later.
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\post-install-offline.ps1"" -AppDir ""{app}"" -AgentHooksOnly -UserProfileRoot ""{param:UserProfileRoot|}"""; \
  StatusMsg: "Configuring Agent CLI hooks..."; \
  Flags: runhidden waituntilterminated runasoriginaluser; Check: RuntimeExtractionSucceeded

; Generate desktop-config.json with release metadata (clowder-ai#1107 intake)
Filename: "powershell.exe"; \
  Parameters: "-ExecutionPolicy Bypass -Command ""& '{app}\scripts\generate-desktop-config.ps1' -AppDir '{app}' -Version '{#MyAppVersion}' -InstallType 'installer'"""; \
  StatusMsg: "Generating desktop configuration..."; \
  Flags: runhidden waituntilterminated; Check: RuntimeExtractionSucceeded

; The intranet installer never launches the application, interactively or silently.
; Start it manually from the installed desktop shortcut after Setup has exited.

; ── F273: Clean previous version's tar-extracted dirs before upgrade ───
; These are NOT tracked by Inno's file registry (created by tar.exe in [Run]).
; Without this, old module files / deleted packages persist across upgrades —
; an extremely hard-to-debug class of staleness bugs.
; The junction must be removed first (rmdir only deletes the link, not target).
; Recovery: if install fails after delete, rerunning the installer restores everything.
[InstallDelete]
Type: filesandordirs; Name: "{app}\scripts\node_modules"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\packages"
Type: filesandordirs; Name: "{app}\desktop-dist"
Type: filesandordirs; Name: "{app}\node"
; Replace the Windows materialized shared-ref alias deterministically.  This
; is package-owned content under {app}; it is not user HOME or history data.
Type: filesandordirs; Name: "{app}\cat-cafe-skills\.cat-cafe-shared-refs"

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\stop-installed-desktop.ps1"" -AppDir ""{app}"""; \
  Flags: runhidden waituntilterminated
[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
; Directories created by tar.exe extraction are not tracked by Inno Setup's
; built-in file registry — must be explicitly listed for clean removal.
Type: filesandordirs; Name: "{app}\packages"
Type: filesandordirs; Name: "{app}\desktop-dist"
Type: filesandordirs; Name: "{app}\node"
Type: filesandordirs; Name: "{app}\bundled"
; scripts/node_modules junction created by mklink /J in [Run]
Type: filesandordirs; Name: "{app}\scripts\node_modules"

; ── F273: Defensive process cleanup before upgrade ────────────────────
; The in-app updater calls quitApp() → stopAll() before spawning the installer.
; For a manually launched Setup.exe, request the same coordinated shutdown
; through Electron's single-instance channel, then retain a bounded fallback
; for orphaned processes that still hold file locks in {app}\.
; PrepareToInstall kills ONLY processes whose executable path is under {app} —
; no risk of killing the user's own node/redis instances running elsewhere.
[Code]
#include "runtime-failure.iss"
procedure ExtractionOutput(const S: String; const Error, FirstLine: Boolean);
var
  Fields: TArrayOfString;
begin
  // Script Exec disables the form. Restore window movement, keeping cancel guarded.
  if RuntimeExtractionBusy and not RuntimeExtractionWindowRestored then begin
    // TWindowDisabler changes the HWND directly; toggle the VCL property as well.
    WizardForm.Enabled := False;
    WizardForm.Enabled := True;
    RuntimeExtractionWindowRestored := True;
  end;
  Log(S);
  if Error then exit;
  Fields := StringSplit(S, ['|'], stAll);
  if (GetArrayLength(Fields) <> 7) or (Fields[0] <> 'EXTRACT') then exit;
  WizardForm.StatusLabel.Caption := 'Extracting ' + Fields[2] + ' - ' + Fields[3] + '%';
  WizardForm.FilenameLabel.Caption := Fields[4] + ' / ' + Fields[5] + ' entries - ' + IntToStr(StrToIntDef(Fields[6], 0) div 1000) + 's (' + Fields[1] + ')';
end;

procedure ExtractRuntimeArchive(ArchiveName: String);
var
  ProgramPath, Arguments, AppDir: String;
  ExitCode: Integer;
  Started, CancelWasEnabled: Boolean;
begin
  if not RuntimeExtractionSucceeded then exit;
  AppDir := ExpandConstant('{app}');
  WizardForm.StatusLabel.Caption := 'Extracting ' + ArchiveName + '...';
  if ArchiveName = 'node.tar.gz' then begin
    ProgramPath := ExpandConstant('{sys}\tar.exe');
    Arguments := '-xzf "' + AppDir + '\bundled\archives\node.tar.gz" -C "' + AppDir + '\node"';
  end else begin
    ProgramPath := AppDir + '\node\node.exe';
    Arguments := '"' + AppDir + '\scripts\extract-runtime-archive.cjs" "' + AppDir + '" "' + ArchiveName + '"';
  end;
  Log('Runtime extraction starting: ' + ArchiveName);
  RuntimeExtractionBusy := True;
  RuntimeExtractionWindowRestored := False;
  CancelWasEnabled := WizardForm.CancelButton.Enabled;
  WizardForm.CancelButton.Enabled := False;
  try
    if ArchiveName = 'node.tar.gz' then
      Started := Exec(ProgramPath, Arguments, AppDir, SW_HIDE, ewWaitUntilTerminated, ExitCode)
    else
      Started := ExecAndLogOutput(ProgramPath, Arguments, AppDir, SW_SHOWNORMAL, ewWaitUntilTerminated, ExitCode, @ExtractionOutput);
  finally
    RuntimeExtractionBusy := False;
    WizardForm.CancelButton.Enabled := CancelWasEnabled;
  end;
  Log('Runtime extraction ' + ArchiveName + ': exit=' + IntToStr(ExitCode));
  if (not Started) or (ExitCode <> 0) then
    FailRuntimeExtraction('Runtime extraction failed: ' + ArchiveName + '. See setup log and ' + AppDir + '\.installer-logs\extract-runtime.log');
  if (ArchiveName = 'node.tar.gz') and (not FileExists(AppDir + '\node\node.exe')) then
    FailRuntimeExtraction('Bundled Node.js is incomplete. Installation cannot continue.');
end;

#include "installation-identity.iss"
