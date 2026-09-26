/**
 * Architecture verification for packaged macOS bundles.
 *
 * Why this exists
 * ---------------
 * `build-mac.sh` runs a single `pnpm install` / `pnpm deploy` on the build
 * host. Native modules are therefore installed for the HOST architecture only.
 * When the same host then packages a foreign architecture (x64 .app produced on
 * an Apple Silicon host), the foreign bundle receives host-arch binaries:
 *
 *   x64 bundle -> better-sqlite3/build/Release/better_sqlite3.node  (arm64)  ✗
 *   x64 bundle -> sqlite-vec-darwin-arm64/vec0.dylib                (arm64)  ✗
 *
 * Such a bundle starts but crashes the moment the API loads SQLite.
 *
 * Not every mismatch is a bug, which is why the check is family-aware:
 *   - node-pty ships `prebuilds/darwin-arm64/pty.node` AND
 *     `prebuilds/darwin-x64/pty.node` in the same bundle. The loader picks the
 *     matching one at runtime, so a foreign-arch sibling is expected and fine.
 *   - sqlite-vec / sharp ship one platform package per install. A single
 *     arm64-only variant inside an x64 bundle is a hard failure.
 *
 * Rule: a "family" is the set of variant paths that differ only by their
 * platform-arch token. The family passes if any member matches the target
 * architecture; a family with no target member fails. Binaries that carry no
 * arch token are arch-pinned single builds and must match directly.
 *
 * Pure logic only — no filesystem or child_process access — so it runs and is
 * unit-tested on any platform. See verify-mac-bundle-arch.mjs for the CLI.
 */

/** Mach-O arch name reported by `lipo -archs` for a given build arch label. */
const BUILD_ARCH_TO_MACHO = {
  arm64: 'arm64',
  x64: 'x86_64',
};

/** Platform tokens that are irrelevant inside a macOS .app bundle. */
const FOREIGN_PLATFORM_TOKENS = new Set(['linux', 'win32', 'freebsd']);

const PLATFORM_ARCH_RE = /(?:^|[-_/])(darwin|mas|linux|win32|freebsd)[-_](arm64|x64|ia32|universal)(?=[-_/.]|$)/;

/** Map a build arch label ("arm64" | "x64") to its Mach-O arch name. */
export function machOArchForBuildArch(buildArch) {
  const macho = BUILD_ARCH_TO_MACHO[buildArch];
  if (!macho) {
    throw new Error(
      `Unsupported macOS build arch "${buildArch}". Expected one of: ${Object.keys(BUILD_ARCH_TO_MACHO).join(', ')}.`,
    );
  }
  return macho;
}

/** Parse `lipo -archs <file>` stdout ("x86_64 arm64") into a sorted arch list. */
export function parseLipoArchs(stdout) {
  if (typeof stdout !== 'string') return [];
  return [...new Set(stdout.trim().split(/\s+/).filter(Boolean))].sort();
}

/**
 * Extract the platform/arch tokens encoded in a bundle-relative path.
 * Returns `{ platform, archToken, familyKey }` where `familyKey` normalises the
 * arch token so that sibling variants collapse into one family.
 */
export function parseNativePath(relPath) {
  const normalised = String(relPath).split('\\').join('/');
  const match = PLATFORM_ARCH_RE.exec(normalised);
  if (!match) {
    return { platform: null, archToken: null, familyKey: normalised };
  }
  const [full, platform, archToken] = match;
  return {
    platform,
    archToken,
    familyKey: normalised.replace(full, full.replace(`-${archToken}`, '-<arch>')),
  };
}

/** True when the path names a platform that never loads inside a macOS bundle. */
function isForeignPlatform({ platform }) {
  return Boolean(platform) && FOREIGN_PLATFORM_TOKENS.has(platform);
}

/** True when `lipo` could not report any architecture for the entry. */
function isUnreadable(entry) {
  return Boolean(entry.error) || !Array.isArray(entry.archs) || entry.archs.length === 0;
}

/** Does one variant of a family satisfy the requested target architecture? */
function memberSatisfiesTarget(member, targetToken, targetMachO) {
  if (member.archToken === 'universal') return true;
  if (member.archToken === targetToken) return true;
  if (member.archToken) return false; // pinned to a different arch
  return member.archs.includes(targetMachO); // unpinned single build
}

/** Bucket entries into arch-token-normalised families, splitting out the rest. */
function collectFamilies(entries) {
  const families = new Map();
  const skipped = [];
  const unreadable = [];

  for (const entry of entries) {
    const parsed = parseNativePath(entry.path);
    if (isForeignPlatform(parsed)) {
      skipped.push(entry);
      continue;
    }
    if (isUnreadable(entry)) {
      unreadable.push(entry);
      continue;
    }
    const members = families.get(parsed.familyKey) ?? [];
    members.push({ ...entry, archToken: parsed.archToken, familyKey: parsed.familyKey });
    families.set(parsed.familyKey, members);
  }

  return { families, skipped, unreadable };
}

/** A family is clean once ANY variant matches the target architecture. */
function collectMismatches(families, targetToken, targetMachO) {
  const mismatches = [];
  for (const [familyKey, members] of families) {
    if (members.some((member) => memberSatisfiesTarget(member, targetToken, targetMachO))) continue;
    for (const member of members) {
      mismatches.push({
        familyKey,
        path: member.path,
        archs: member.archs,
        reason: member.archToken
          ? `path declares "${member.archToken}" but the target is "${targetToken}"`
          : `binary contains [${member.archs.join(', ')}] but the target needs ${targetMachO}`,
      });
    }
  }
  return mismatches;
}

/**
 * Decide whether every architecture-sensitive Mach-O entry can load on
 * `targetArch`.
 *
 * @param {{ targetArch: string, entries: Array<{path: string, archs?: string[], error?: string}> }} input
 *   `entries[].path` is relative to the .app bundle. Entries for foreign
 *   platforms (linux/win32 prebuilds) are ignored — they are never loaded on
 *   macOS.
 * @returns {{
 *   ok: boolean, targetArch: string, targetMachO: string,
 *   checkedFamilies: number, skipped: Array<object>,
 *   mismatches: Array<{familyKey: string, path: string, archs: string[], reason: string}>,
 *   unreadable: Array<object>,
 * }}
 */
export function evaluateBundleArch({ targetArch, entries }) {
  const targetMachO = machOArchForBuildArch(targetArch);
  const { families, skipped, unreadable } = collectFamilies(entries);
  const mismatches = collectMismatches(families, targetArch, targetMachO);

  return {
    ok: mismatches.length === 0,
    targetArch,
    targetMachO,
    checkedFamilies: families.size,
    skipped,
    mismatches,
    unreadable,
  };
}

/**
 * Build an actionable failure message following the project error standard:
 * what failed, why, and how to fix it.
 */
export function formatBundleArchFailure({ appPath, targetArch, result }) {
  const lines = [
    `macOS bundle architecture check failed for ${targetArch}: ${appPath}`,
    `  why: ${result.mismatches.length} native binary/binaries cannot load on ${result.targetMachO}.`,
  ];
  for (const mismatch of result.mismatches.slice(0, 20)) {
    lines.push(`    - ${mismatch.path} [${mismatch.archs.join(', ')}] — ${mismatch.reason}`);
  }
  if (result.mismatches.length > 20) {
    lines.push(`    ... and ${result.mismatches.length - 20} more`);
  }
  lines.push(
    '  fix: build each architecture on a host of that architecture, or rebuild the',
    '       dependencies for the target arch before packaging',
    `       (\`pnpm install --config.arch=${targetArch}\` in a ${targetArch} Node runtime).`,
    '       The release pipeline already does this by using a separate runner per arch.',
  );
  return lines.join('\n');
}
