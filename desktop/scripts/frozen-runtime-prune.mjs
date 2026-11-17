import fs from 'node:fs';
import path from 'node:path';

/**
 * Packaging redundancy removal for the frozen deployment tree.
 *
 * This runs in the export layer (desktop/scripts/frozen-runtime-deploy.mjs)
 * before startup profiling, so the installer archive and the portable zip are
 * produced from the same file set. The archive layer only compresses and
 * records integrity; it must not delete files.
 */
const CATEGORIES = {
  swc: [/(?:^|\/)@next\/swc-[^/]+(?:\/|$)/],
  // Only the win32-x64 target is supported; every other platform build is dead weight there.
  // `@img/sharp-wasm32` is intentionally kept: sharp 0.34.5 treats it as a cross-platform fallback.
  platform: [
    /(?:^|\/)@esbuild\/(?:darwin|linux|freebsd|openbsd|netbsd|sunos|aix|android|win32-arm64|win32-ia32)(?:-[^/]+)?(?:\/|$)/,
    /(?:^|\/)@img\/sharp(?:-libvips)?-(?:darwin|linux|linuxmusl|win32-arm64|win32-ia32)(?:-[^/]+)?(?:\/|$)/,
    /(?:^|\/)node-pty\/prebuilds\/(?:darwin|linux|win32-arm64|win32-ia32)(?:-[^/]+)?(?:\/|$)/,
    /(?:^|\/)@anthropic-ai\/claude-agent-sdk-(?:darwin|linux)(?:-[^/]+)?(?:\/|$)/,
  ],
  maps: [/\.map$/],
};

function toPosix(relative) {
  return relative.replaceAll('\\', '/');
}

function walk(root, directory = root, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(root, absolute, output);
    else if (entry.isFile())
      output.push({ absolute, relative: toPosix(path.relative(root, absolute)), bytes: fs.statSync(absolute).size });
  }
  return output;
}

/**
 * @param {string} root frozen dependency tree (the materialized `node_modules`)
 * @param {{swc?: boolean, platform?: boolean, maps?: boolean, dryRun?: boolean, target?: 'win32-x64'}} options
 * @returns {{removedFiles: number, removedBytes: number, byCategory: Record<string, {files: number, bytes: number}>}}
 */
export function pruneFrozenRuntimeRedundancy(
  root,
  { swc = false, platform = false, maps = false, dryRun = false, target = 'win32-x64' } = {},
) {
  if (platform && target !== 'win32-x64') throw new Error(`Unsupported prune target: ${target}`);
  const enabled = Object.entries({ swc, platform, maps })
    .filter(([, value]) => value)
    .map(([name]) => name);
  const byCategory = Object.fromEntries(enabled.map((name) => [name, { files: 0, bytes: 0 }]));
  if (enabled.length === 0) return { removedFiles: 0, removedBytes: 0, byCategory };

  let removedFiles = 0;
  let removedBytes = 0;
  for (const file of walk(root)) {
    const category = enabled.find((name) => CATEGORIES[name].some((pattern) => pattern.test(file.relative)));
    if (!category) continue;
    byCategory[category].files++;
    byCategory[category].bytes += file.bytes;
    removedFiles++;
    removedBytes += file.bytes;
    if (!dryRun) fs.rmSync(file.absolute, { force: true });
  }
  return { removedFiles, removedBytes, byCategory };
}
