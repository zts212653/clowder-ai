import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BleHelperProcess extends EventEmitter {
  stdin: {
    write(data: string, callback?: (error?: Error | null) => void): boolean;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(signal?: NodeJS.Signals): boolean;
}

export function resolveBleHelperExecutable(
  arch = process.arch,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const apiRoot = resolve(moduleDir, '../../../..');
  const packagedArchitecture = arch === 'arm64' ? 'arm64' : 'x64';
  const localBuildArchitecture = arch === 'x64' ? 'x86_64' : packagedArchitecture;
  const candidates = [
    resolve(apiRoot, 'ble-helper', 'ble-helper'),
    resolve(apiRoot, '..', '..', 'bundled', `ble-helper-darwin-${packagedArchitecture}`, 'ble-helper'),
    resolve(apiRoot, '..', '..', 'native', 'ble-helper', 'macos', '.build', localBuildArchitecture, 'ble-helper'),
  ];
  const executable = candidates.find(fileExists);
  if (!executable) {
    throw new Error('BLE helper executable not found');
  }
  return executable;
}

export function spawnBleHelperProcess(helperPath?: string): BleHelperProcess {
  const executable = helperPath ?? resolveBleHelperExecutable();
  return spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false }) as ChildProcessWithoutNullStreams;
}
