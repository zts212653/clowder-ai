const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { buildAppAssist } = require('./build-app-assist.cjs');

if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ status: 'unsupported', nativeExecuted: false }));
} else {
  const output = mkdtempSync(join(tmpdir(), 'f317-app-assist-native-'));
  const root = resolve(__dirname, '..');
  const fixture = join(output, 'synthetic-notification-fixture');
  execFileSync(
    'xcrun',
    [
      'swiftc',
      join(root, 'native/app-assist/ApplicationProjection.swift'),
      join(root, 'native/app-assist/ActivationSource.swift'),
      join(root, 'test/app-assist-native-fixture.swift'),
      '-o',
      fixture,
    ],
    { timeout: 120000, stdio: 'pipe' },
  );
  assert.match(execFileSync(fixture, [], { timeout: 10000, encoding: 'utf8' }), /synthetic-native-activation: passed/);
  const architectures = [];
  for (const arch of ['arm64', 'x64']) {
    const binary = buildAppAssist(join(output, `app-assist-${arch}`), arch);
    const actual = execFileSync('lipo', ['-archs', binary], { encoding: 'utf8' }).trim();
    assert.equal(actual, arch === 'x64' ? 'x86_64' : 'arm64');
    architectures.push(actual);
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      syntheticNotificationCenterOnly: true,
      architectures,
      productionObserverExecuted: false,
      queriedForeground: false,
      packagedPermissionVerified: false,
      retainedArtifacts: output,
    }),
  );
}
