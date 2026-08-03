import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveBleHelperExecutable } from '../dist/domains/limb/ble/BleHelperProcess.js';

describe('BleHelperProcess', () => {
  it('resolves an Intel source build from the x86_64 Swift output directory', () => {
    const executable = resolveBleHelperExecutable('x64', (candidate) =>
      candidate.endsWith('/native/ble-helper/macos/.build/x86_64/ble-helper'),
    );

    assert.match(executable, /\/native\/ble-helper\/macos\/\.build\/x86_64\/ble-helper$/);
  });

  it('keeps the packaged Intel helper directory normalized as x64', () => {
    const executable = resolveBleHelperExecutable('x64', (candidate) =>
      candidate.endsWith('/bundled/ble-helper-darwin-x64/ble-helper'),
    );

    assert.match(executable, /\/bundled\/ble-helper-darwin-x64\/ble-helper$/);
  });
});
