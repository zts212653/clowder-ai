import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');

export const installScript = readFileSync(join(repoRoot, 'scripts', 'install.ps1'), 'utf8');
const commandHelpersPath = join(repoRoot, 'scripts', 'windows-command-helpers.ps1');
export const commandHelpersScript = existsSync(commandHelpersPath) ? readFileSync(commandHelpersPath, 'utf8') : '';
const uiHelpersPath = join(repoRoot, 'scripts', 'windows-installer-ui.ps1');
export const uiHelpersScript = existsSync(uiHelpersPath) ? readFileSync(uiHelpersPath, 'utf8') : '';
export const helpersScript = readFileSync(join(repoRoot, 'scripts', 'install-windows-helpers.ps1'), 'utf8');
export const startWindowsScript = readFileSync(join(repoRoot, 'scripts', 'start-windows.ps1'), 'utf8');
const stopWindowsPath = join(repoRoot, 'scripts', 'stop-windows.ps1');
export const stopWindowsScript = existsSync(stopWindowsPath) ? readFileSync(stopWindowsPath, 'utf8') : '';
const startBatPath = join(repoRoot, 'scripts', 'start.bat');
export const startBatScript = existsSync(startBatPath) ? readFileSync(startBatPath, 'utf8') : '';
