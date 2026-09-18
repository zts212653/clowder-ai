#!/usr/bin/env node
/**
 * Fail-closed architecture verification for a packaged macOS .app bundle.
 *
 * Walks the bundle, reads the Mach-O architectures of every `.node` / `.dylib`
 * with `lipo -archs`, and fails when a binary that is loaded unconditionally on
 * macOS cannot run on the target architecture.
 *
 * Usage:
 *   node desktop/scripts/verify-mac-bundle-arch.mjs \
 *     --app "desktop/dist/mac/Clowder AI.app" --arch x64
 *
 * Exit codes: 0 = verified, 1 = mismatch (broken bundle), 2 = bad usage/host.
 *
 * The decision logic lives in ./lib/mac-native-arch.mjs and is unit-tested on
 * every platform; this file only does filesystem + `lipo` IO.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  evaluateBundleArch,
  formatBundleArchFailure,
  parseLipoArchs,
  parseNativePath,
} from './lib/mac-native-arch.mjs';

const NATIVE_EXTENSIONS = new Set(['.node', '.dylib']);

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { app: null, arch: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--app') args.app = argv[++i];
    else if (flag === '--arch') args.arch = argv[++i];
    else if (flag === '--quiet') args.quiet = true;
    else fail(`Unknown flag: ${flag}`, 2);
  }
  if (!args.app || !args.arch) {
    fail('Usage: verify-mac-bundle-arch.mjs --app <bundle.app> --arch <arm64|x64>', 2);
  }
  return args;
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // unreadable subtree — nothing to verify there
  }
}

/**
 * Only macOS-loadable binaries matter. Foreign-platform prebuilds (linux/win32)
 * are never loaded on macOS and `lipo` cannot read them, so skip them up front.
 */
function isMacNativeBinary(relPath) {
  if (!NATIVE_EXTENSIONS.has(path.extname(relPath))) return false;
  const { platform } = parseNativePath(relPath);
  return !platform || platform === 'darwin' || platform === 'mas';
}

function walkNativeBinaries(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readDirSafe(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relPath = path.relative(root, full).split(path.sep).join('/');
      if (isMacNativeBinary(relPath)) found.push({ full, relPath });
    }
  }
  return found;
}

function readArchs(fullPath) {
  try {
    return { archs: parseLipoArchs(execFileSync('lipo', ['-archs', fullPath], { encoding: 'utf8' })) };
  } catch (error) {
    return { archs: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.platform !== 'darwin') {
    fail(
      `verify-mac-bundle-arch must run on macOS (detected ${process.platform}) because it shells out to "lipo". ` +
        'Run it in the macOS release pipeline; the decision logic itself is unit-tested on all platforms.',
      2,
    );
  }
  if (!fs.existsSync(args.app)) {
    fail(`macOS bundle not found: ${args.app}. Run electron-builder before this check.`, 2);
  }

  const binaries = walkNativeBinaries(args.app);
  if (binaries.length === 0) {
    fail(
      `No .node/.dylib binaries found under ${args.app}. The bundle looks incomplete — ` +
        'check that afterPack copied the deployed node_modules before trusting this build.',
      2,
    );
  }

  const entries = binaries.map(({ full, relPath }) => ({ path: relPath, ...readArchs(full) }));
  const result = evaluateBundleArch({ targetArch: args.arch, entries });

  if (!args.quiet) {
    process.stdout.write(
      `  arch check: ${args.arch} target, ${result.checkedFamilies} native famil(ies), ` +
        `${entries.length} binary/binaries scanned, ${result.skipped.length} foreign-platform skipped\n`,
    );
    for (const unreadable of result.unreadable) {
      process.stdout.write(`    [warn] could not read architecture: ${unreadable.path}\n`);
    }
  }

  if (!result.ok) {
    fail(formatBundleArchFailure({ appPath: args.app, targetArch: args.arch, result }), 1);
  }

  if (!args.quiet) process.stdout.write(`  [OK] every native binary supports ${result.targetMachO}\n`);
}

main();
