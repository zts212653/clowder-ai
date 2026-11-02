import fs from 'node:fs';
import path from 'node:path';

const foreignNodePtyPrebuilds = new Set(['win32-arm64', 'linux-arm64', 'linux-x64', 'darwin-arm64', 'darwin-x64']);

/** Select only audited foreign node-pty prebuilds; preserve unknown packages and platforms. */
export function nativeRuntimeAssetFilter(workspace, targetPlatform) {
  const packageNames = new Map();
  return (file) => {
    if (targetPlatform !== 'win32-x64') return true;
    const relative = path.relative(workspace, file).replaceAll('\\', '/');
    const match = relative.match(/(?:^|\/)node_modules\/node-pty\/prebuilds\/([^/]+)/);
    if (!match || !foreignNodePtyPrebuilds.has(match[1])) return true;
    const manifest = path.resolve(workspace, relative.slice(0, match.index), 'node_modules/node-pty/package.json');
    if (!packageNames.has(manifest))
      packageNames.set(manifest, fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).name : null);
    return packageNames.get(manifest) !== 'node-pty';
  };
}
