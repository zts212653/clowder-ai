@echo off
setlocal EnableDelayedExpansion

rem Cat Cafe Portable — launch script
rem Detects first run, auto-configures, then starts the Electron app.
rem Equivalent to Inno Setup [Run] section but without admin requirement.

set "APPDIR=%~dp0"
rem Remove trailing backslash
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"

rem ── First-run configuration ──────────────────────────────────────────
if not exist "%APPDIR%\.env" (
    echo.
    echo  ============================================
    echo   Cat Cafe — First Run Configuration
    echo  ============================================
    echo.

    rem Step 1: Generate .env, mount skills, verify artifacts
    rem (post-install-offline.ps1 without CLI flags = skip CLI provisioning;
    rem  CLI tools are user-choice in portable mode — install separately)
    powershell -NoProfile -ExecutionPolicy Bypass -File "%APPDIR%\scripts\post-install-offline.ps1" -AppDir "%APPDIR%"
    echo.

    rem Step 2: Sync Agent CLI hooks to user profile (~/.claude, ~/.codex)
    rem so any existing CLI installations can connect to this Cat Cafe instance.
    powershell -NoProfile -ExecutionPolicy Bypass -File "%APPDIR%\scripts\post-install-offline.ps1" -AppDir "%APPDIR%" -AgentHooksOnly
    echo.

    rem Step 3: Generate desktop-config.json (records installed components)
    rem Portable mode: no CLI components pre-selected (omit switch = false)
    powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%APPDIR%\scripts\generate-desktop-config.ps1' -AppDir '%APPDIR%'"
    echo.

    if errorlevel 1 (
        echo  [!!] Configuration encountered issues. See above for details.
        echo       Cat Cafe will still attempt to start.
        echo.
    ) else (
        echo  [OK] Configuration complete.
        echo.
    )
)

rem ── Enable long paths (best-effort, requires admin) ──────────────────
rem Long paths prevent EPERM errors when pnpm creates deeply nested
rem node_modules. If this fails (non-admin), it's not fatal.
reg query "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled 2>nul | find "0x1" >nul 2>&1
if errorlevel 1 (
    reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f >nul 2>&1
    if not errorlevel 1 (
        echo  [OK] Windows long path support enabled.
    )
)

rem ── Launch Cat Cafe ──────────────────────────────────────────────────
echo  Starting Cat Cafe...
start "" "%APPDIR%\desktop-dist\Cat Cafe.exe"
