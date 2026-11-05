const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

// Release-time compilation, never a runtime Xcode dependency or observer launch.
function buildAppAssist(output, arch = process.arch) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch))
    throw new Error('Unsupported app-assist build');
  const root = path.resolve(__dirname, '../native/app-assist');
  mkdirSync(path.dirname(output), { recursive: true });
  execFileSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-target',
      `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos11.0`,
      path.join(root, 'ApplicationProjection.swift'),
      path.join(root, 'ActivationSource.swift'),
      path.join(root, 'main.swift'),
      '-o',
      output,
    ],
    { stdio: 'pipe', timeout: 120000 },
  );
  return output;
}
module.exports = { buildAppAssist };
if (require.main === module && process.platform === 'darwin') {
  buildAppAssist(path.resolve(__dirname, '../plugin-window/native/app-assist'));
}
