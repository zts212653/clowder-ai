import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeNodeVersion,
  pickRedisReleaseAsset,
  shouldCopyRepoPath,
  WINDOWS_MANAGED_TOP_LEVEL_PATHS,
  WINDOWS_PRESERVE_PATHS,
} from '../../../scripts/build-windows-installer.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const buildScript = readFileSync(join(repoRoot, 'scripts', 'build-windows-installer.mjs'), 'utf8');
const launcherBuildScript = readFileSync(join(repoRoot, 'scripts', 'build-windows-webview2-launcher.ps1'), 'utf8');
const launcherSource = readFileSync(join(repoRoot, 'packaging', 'windows', 'desktop', 'ClowderDesktop.cs'), 'utf8');
const apiClientSource = readFileSync(join(repoRoot, 'packages', 'web', 'src', 'utils', 'api-client.ts'), 'utf8');
const nsisScript = readFileSync(join(repoRoot, 'packaging', 'windows', 'installer.nsi'), 'utf8');

test('Windows offline installer keeps mutable state outside managed payload cleanup', () => {
  assert.deepEqual(WINDOWS_PRESERVE_PATHS, ['.env', 'cat-config.json', 'data', 'logs', '.cat-cafe']);
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('packages'));
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('scripts'));
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('cat-cafe-skills'));
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('tools'));
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('installer-seed'));
  assert.ok(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('vendor'));
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('docs'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('README.md'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('AGENTS.md'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('CLAUDE.md'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('GEMINI.md'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('data'), false);
  assert.equal(WINDOWS_MANAGED_TOP_LEVEL_PATHS.includes('.cat-cafe'), false);
});

test('Windows offline installer normalizes bundled Node versions and filters copied repo paths', () => {
  assert.equal(normalizeNodeVersion('22.20.0'), 'v22.20.0');
  assert.equal(normalizeNodeVersion('v20.11.1'), 'v20.11.1');

  assert.equal(shouldCopyRepoPath('packages/api/src/index.ts'), true);
  assert.equal(shouldCopyRepoPath('docs/README.md'), true);
  assert.equal(shouldCopyRepoPath('.env'), false);
  assert.equal(shouldCopyRepoPath('data/evidence.sqlite'), false);
  assert.equal(shouldCopyRepoPath('logs/api.log'), false);
  assert.equal(shouldCopyRepoPath('node_modules/next/package.json'), false);
  assert.equal(shouldCopyRepoPath('packages/api/dist/index.js'), false);
  assert.equal(shouldCopyRepoPath('packages/web/.next/server.js'), false);
});

test('Windows offline installer prefers plain Redis portable zips before service bundles', () => {
  const asset = pickRedisReleaseAsset([
    { name: 'Redis-8.2.1-Windows-x64-msys2-with-Service.zip', browser_download_url: 'https://example.com/service.zip' },
    { name: 'Redis-8.2.1-Windows-x64-cygwin.zip', browser_download_url: 'https://example.com/cygwin.zip' },
    { name: 'Redis-8.2.1-Windows-x64-msys2.zip', browser_download_url: 'https://example.com/msys2.zip' },
  ]);
  assert.equal(asset?.name, 'Redis-8.2.1-Windows-x64-msys2.zip');
});

test('Windows offline bundle builder deploys production packages and bundles Windows runtimes', () => {
  assert.match(buildScript, /WINDOWS_RUNTIME_NPM_ARGS = \['install', '--omit=dev'/);
  assert.match(
    buildScript,
    /const entries = \['cat-cafe-skills', 'LICENSE', '\.env\.example', 'cat-template\.json', 'vendor'\]/,
  );
  assert.match(buildScript, /RUNTIME_SCRIPT_FILES = \[/);
  assert.match(buildScript, /stageRuntimePackageTemplate\(targetRootDir, 'shared'/);
  assert.match(buildScript, /stageRuntimePackageTemplate\(targetRootDir, 'api'/);
  assert.match(buildScript, /stageRuntimePackageTemplate\(targetRootDir, 'mcp-server'/);
  assert.match(buildScript, /stageRuntimePackageTemplate\(targetRootDir, 'web'/);
  assert.match(buildScript, /dependencies\['@cat-cafe\/shared'\] = 'file:\.\.\/shared'/);
  assert.match(buildScript, /RUNTIME_WEB_NEXT_CONFIG = `function resolveApiBaseUrl\(\)/);
  assert.match(buildScript, /runWindowsNpmInstall\(windowsNode\.npmCmdPath/);
  assert.match(buildScript, /run\('pnpm', \['--filter', '@cat-cafe\/shared', 'run', 'build'\]\)/);
  assert.match(buildScript, /materializeSharedDependency\(windowsPackagesWslDir, packageName\)/);
  assert.match(buildScript, /lstatSync\(sharedLinkPath\)\.isSymbolicLink\(\)/);
  assert.match(buildScript, /powershell\.exe/);
  assert.match(buildScript, /--package-lock=false/);
  assert.match(buildScript, /--loglevel=error/);
  assert.match(buildScript, /'next-env\.d\.ts'/);
  assert.match(buildScript, /'postcss\.config\.js'/);
  assert.match(buildScript, /'tailwind\.config\.js'/);
  assert.match(buildScript, /'vitest\.config\.ts'/);
  assert.match(buildScript, /'\.next\/types'/);
  assert.match(buildScript, /'\.next\/standalone'/);
  assert.match(buildScript, /removeNamedDirectoriesRecursive\(targetDir, \['test', 'tests', '__tests__'\]\)/);
  assert.match(buildScript, /fileName === 'package-lock\.json' \|\| fileName === '\.package-lock\.json'/);
  assert.match(buildScript, /removePaths\(targetDir, \['node_modules', 'corepack', 'include', 'share'\]\)/);
  assert.match(buildScript, /computeMaxRelativePathLength\(bundleDir\)/);
  assert.match(buildScript, /MAX_REL_PATH_LEN=/);
  assert.match(buildScript, /MAX_INSTALL_ROOT_LEN=/);
  assert.match(buildScript, /node-\$\{options\.nodeVersion\}-win-x64\.zip/);
  assert.match(buildScript, /redis-windows\/redis-windows\/releases\/latest/);
  assert.match(buildScript, /build-windows-webview2-launcher\.ps1/);
  assert.match(buildScript, /createIcoFromPng\(launcherIconSource, launcherIconPath\)/);
  assert.match(buildScript, /wslpath is required to build the Windows WebView2 launcher from Linux/);
  assert.match(buildScript, /Building WebView2 desktop launcher/);
  assert.match(buildScript, /Finalizing runtime bundle/);
  assert.match(buildScript, /writeReleaseMetadata\(bundleDir, \{/);
});

test('Windows WebView2 launcher build bundles the required SDK files and desktop host logic', () => {
  assert.match(launcherBuildScript, /microsoft\.web\.webview2\.\$WebView2Version\.nupkg/);
  assert.match(launcherBuildScript, /Microsoft\.Web\.WebView2\.Core\.dll/);
  assert.match(launcherBuildScript, /Microsoft\.Web\.WebView2\.WinForms\.dll/);
  assert.match(launcherBuildScript, /WebView2Loader\.dll/);
  assert.match(launcherBuildScript, /ClowderAI\.Desktop\.exe/);
  assert.match(launcherBuildScript, /csc\.exe/);
  assert.match(launcherBuildScript, /\/win32icon:\$IconFile/);

  assert.match(launcherSource, /new WebView2/);
  assert.match(launcherSource, /EnsureCoreWebView2Async/);
  assert.match(launcherSource, /start-windows\.ps1/);
  assert.match(launcherSource, /stop-windows\.ps1/);
  assert.match(launcherSource, /Local\\ClowderAI\.WebView2Desktop/);
  assert.match(launcherSource, /http:\/\/127\.0\.0\.1:/);
});

test('Windows desktop launcher reads runtime state, minimizes to tray, and exits through the tray menu', () => {
  assert.match(launcherSource, /runtime-state\.json/);
  assert.match(launcherSource, /NotifyIcon/);
  assert.match(launcherSource, /ContextMenuStrip/);
  assert.match(launcherSource, /Open Clowder AI/);
  assert.match(launcherSource, /HideToTray/);
  assert.match(launcherSource, /RequestExit/);
  assert.match(launcherSource, /TryReadRuntimeStateValue/);
  assert.match(launcherSource, /ShowBalloonTip/);
});

test('Windows startup script pins bundled config roots for packaged releases', () => {
  assert.match(buildScript, /'cat-template\.json'/);
  assert.match(buildScript, /'\.clowder-release\.json'/);
  assert.match(launcherSource, /AppDomain\.CurrentDomain\.BaseDirectory/);
  const startWindowsScript = readFileSync(join(repoRoot, 'scripts', 'start-windows.ps1'), 'utf8');
  assert.match(startWindowsScript, /if \(\$bundledRelease\) \{/);
  assert.match(startWindowsScript, /\$runtimeEnvOverrides\.CAT_CAFE_CONFIG_ROOT = \$ProjectRoot/);
  assert.match(startWindowsScript, /\$runtimeEnvOverrides\.CAT_TEMPLATE_PATH = \$bundledTemplatePath/);
});

test('Local desktop web client derives API URL from the loopback frontend port instead of a baked localhost:3004 value', () => {
  assert.match(apiClientSource, /function isLoopbackHost/);
  assert.match(apiClientSource, /if \(isLoopbackHost\(location\?\.hostname\)\)/);
  assert.match(apiClientSource, /const frontendPort = Number\(location\?\.port \?\? ''\) \|\| 3003/);
  assert.match(apiClientSource, /const apiPort = frontendPort \+ 1/);
});

test('NSIS installer is per-user, supports upgrade cleanup, and preserves runtime data on uninstall', () => {
  assert.match(nsisScript, /!define DEFAULT_INSTALL_DIR "C:\\CAI"/);
  assert.match(nsisScript, /InstallDir "\$\{DEFAULT_INSTALL_DIR\}"/);
  assert.match(nsisScript, /!define MUI_PAGE_CUSTOMFUNCTION_LEAVE VerifyInstallDirLeave/);
  assert.match(nsisScript, /Function \.onVerifyInstDir/);
  assert.match(nsisScript, /Function VerifyInstallDirLeave/);
  assert.match(nsisScript, /Choose a path with at most \$\{MAX_INSTALL_ROOT_LEN\} characters/);
  assert.match(nsisScript, /RequestExecutionLevel user/);
  assert.match(nsisScript, /Function CloseRunningServices/);
  assert.match(
    nsisScript,
    /ExecWait '"\$WINDIR\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoProfile -ExecutionPolicy Bypass -File "\$INSTDIR\\scripts\\stop-windows\.ps1"'/,
  );
  assert.match(nsisScript, /RMDir \/r "\$INSTDIR\\packages"/);
  assert.match(nsisScript, /RMDir \/r "\$INSTDIR\\tools"/);
  assert.match(nsisScript, /IfFileExists "\$INSTDIR\\\.env" \+2 0/);
  assert.match(nsisScript, /CopyFiles \/SILENT "\$INSTDIR\\\.env\.example" "\$INSTDIR\\\.env"/);
  assert.match(
    nsisScript,
    /CopyFiles \/SILENT "\$INSTDIR\\installer-seed\\cat-config\.json" "\$INSTDIR\\cat-config\.json"/,
  );
  assert.match(nsisScript, /WriteRegStr HKCU "\$\{UNINSTALL_KEY\}" "DisplayVersion" "\$\{APP_VERSION\}"/);
  assert.match(
    nsisScript,
    /CreateShortCut "\$\{STARTMENU_DIR\}\\Start \$\{APP_NAME\}\.lnk" "\$INSTDIR\\ClowderAI\.Desktop\.exe" "" "\$INSTDIR\\ClowderAI\.Desktop\.exe"/,
  );
  assert.match(
    nsisScript,
    /CreateShortCut "\$DESKTOP\\\$\{APP_NAME\}\.lnk" "\$INSTDIR\\ClowderAI\.Desktop\.exe" "" "\$INSTDIR\\ClowderAI\.Desktop\.exe"/,
  );
  assert.match(nsisScript, /Delete "\$DESKTOP\\\$\{APP_NAME\}\.lnk"/);
  assert.match(nsisScript, /User data in data, logs, \.cat-cafe, \.env, and cat-config\.json was preserved/);
});
