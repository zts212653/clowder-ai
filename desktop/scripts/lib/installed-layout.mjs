/**
 * Verification of an INSTALLED desktop tree.
 *
 * The analysis this work started from lists one acceptance criterion above all
 * others: after a clean install on a machine with no Node, pnpm or Redis, the
 * app must still open. Everything else in this PR was verified through source
 * or unit tests; this module is how the install itself gets checked, because
 * "the installer produced the right tree" cannot be proven by reading the
 * build script.
 *
 * It is deliberately split from its CLI (smoke-installed-layout.mjs):
 *   - checkInstalledLayout / evaluateToolchainResults are pure and unit-tested
 *     against fake filesystems and fake command results
 *   - the CLI does the real fs + child_process work on an installed machine
 *
 * fs and command execution are injected, so the checks run anywhere.
 */

/** Paths the Windows installer is expected to produce, relative to its root. */
const REQUIRED_WINDOWS_PATHS = [
  { path: 'node/node.exe', why: 'the bundled Node runtime — without it a clean machine cannot start anything' },
  { path: 'node/npm.cmd', why: 'the bundled npm that post-install scripts rely on' },
  { path: '.cat-cafe/redis/windows/redis-server.exe', why: 'the bundled Redis, so no system Redis is required' },
  { path: '.cat-cafe/desktop-config.json', why: 'install metadata written during setup' },
  { path: 'cat-template.json', why: 'cat model defaults; without it CLI routing 404s' },
  { path: 'pnpm-workspace.yaml', why: 'monorepo marker used by findMonorepoRoot()' },
  { path: 'package.json', why: 'root package manifest' },
  { path: 'packages/api/dist/index.js', why: 'the API entry point' },
  { path: 'packages/api/node_modules', why: 'deployed API dependencies' },
  { path: 'packages/web/.next', why: 'the prebuilt Next.js output' },
  { path: 'packages/web/node_modules', why: 'deployed Web dependencies' },
  { path: 'packages/mcp-server', why: 'the MCP server package' },
  { path: 'desktop-dist/Clowder AI.exe', why: 'the Electron shell that the shortcuts point at' },
  { path: 'desktop/assets', why: 'desktop assets referenced by the uninstaller entry' },
  { path: 'cat-cafe-skills', why: 'skills manifest loaded by the capabilities routes' },
  { path: 'docs', why: 'docs routes' },
  { path: 'plugins', why: 'plugin registry manifests' },
  { path: 'scripts/post-install-offline.ps1', why: '.env and hook setup' },
  { path: 'scripts/node_modules', why: 'junction created at install time (Program Files is read-only later)' },
  { path: '.claude/hooks/user-level', why: 'Agent CLI hook truth source' },
];

/** Paths the macOS .app bundle is expected to contain, relative to the bundle. */
const REQUIRED_DARWIN_PATHS = [
  { path: 'Contents/MacOS', why: 'the Electron executable directory' },
  { path: 'Contents/Resources/node/bin/node', why: 'the bundled Node runtime' },
  { path: 'Contents/Resources/packages/api/dist/index.js', why: 'the API entry point' },
  { path: 'Contents/Resources/packages/web/.next', why: 'the prebuilt Next.js output' },
  { path: 'Contents/Resources/cat-cafe-skills', why: 'skills manifest' },
];

/** Required paths for a platform. */
function requiredPathsFor(platform) {
  if (platform === 'win32') return REQUIRED_WINDOWS_PATHS;
  if (platform === 'darwin') return REQUIRED_DARWIN_PATHS;
  throw new Error(
    `No installed-layout expectations for platform "${platform}".\n` +
      '  fix: add a REQUIRED_*_PATHS list before targeting that platform.',
  );
}

/**
 * Check that an installed tree contains everything the installer promises.
 *
 * @param {{ platform: string, root: string, exists: (absPath: string) => boolean }} input
 * @returns {{ ok: boolean, platform: string, checked: number, missing: Array<{path: string, why: string}> }}
 */
function checkInstalledLayout({ platform, root, exists }) {
  const required = requiredPathsFor(platform);
  const join = (...parts) => parts.join('/').replaceAll('//', '/');
  const missing = [];

  for (const entry of required) {
    if (!exists(join(root, entry.path))) missing.push(entry);
  }

  return { ok: missing.length === 0, platform, checked: required.length, missing };
}

/**
 * Validate the install metadata the setup step writes.
 *
 * @param {string|null} raw JSON text of .cat-cafe/desktop-config.json
 */
function checkDesktopConfig(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'desktop-config.json is missing or empty' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `desktop-config.json is not valid JSON: ${error.message}` };
  }

  const problems = [];
  if (!parsed || typeof parsed !== 'object') problems.push('not an object');
  if (typeof parsed?.installType !== 'string' || parsed.installType === '') problems.push('installType missing');
  if (typeof parsed?.version !== 'string' || parsed.version === '') problems.push('version missing');
  if (problems.length > 0) return { ok: false, reason: `desktop-config.json ${problems.join(', ')}` };

  return { ok: true, config: parsed };
}

/**
 * Commands that prove the *bundled* toolchain works, so the install does not
 * secretly depend on whatever Node or Redis the machine happens to have.
 */
function toolchainChecks({ root }) {
  const nodeExe = `${root}/node/node.exe`;
  return [
    {
      id: 'bundled-node-runs',
      cmd: nodeExe,
      args: ['--version'],
      why: 'the bundled Node must execute on a machine with no system Node',
    },
    {
      id: 'bundled-redis-runs',
      cmd: `${root}/.cat-cafe/redis/windows/redis-server.exe`,
      args: ['--version'],
      why: 'the bundled Redis must execute, not just exist',
    },
    {
      id: 'native-module-abi',
      cmd: nodeExe,
      args: ['-e', "require('better-sqlite3'); require('node-pty');"],
      cwd: `${root}/packages/api`,
      why: 'native modules must load under the BUNDLED Node — the ABI mismatch this whole PR is about',
    },
  ];
}

/** Failure for a command that did not exit cleanly, quoting its own output. */
function describeCommandFailure(result) {
  const detail = String(result.stderr || result.stdout || '')
    .trim()
    .split('\n')
    .slice(0, 3)
    .join(' | ');
  return { id: result.id, reason: `exited with code ${result.code}${detail ? `: ${detail}` : ''}` };
}

/** The bundled Node must clear the declared floor; other checks are not version-pinned. */
function describeNodeVersionFailure(result, nodeMajorFloor) {
  const match = /v(\d+)\./.exec(String(result.stdout ?? ''));
  if (!match) {
    return { id: result.id, reason: `could not parse a version from ${JSON.stringify(result.stdout)}` };
  }
  if (Number(match[1]) < nodeMajorFloor) {
    return { id: result.id, reason: `bundled Node v${match[1]} is below the declared floor v${nodeMajorFloor}` };
  }
  return null;
}

/** Judge one command result, returning a failure or null. */
function judgeToolchainResult(result, nodeMajorFloor) {
  if (result.code !== 0) return describeCommandFailure(result);
  if (result.id !== 'bundled-node-runs' || !nodeMajorFloor) return null;
  return describeNodeVersionFailure(result, nodeMajorFloor);
}

/**
 * Judge the results of toolchainChecks().
 *
 * @param {Array<{id: string, code: number|null, stdout?: string, stderr?: string}>} results
 * @param {{ nodeMajorFloor?: number }} [options]
 */
function evaluateToolchainResults(results, options = {}) {
  const failures = [];

  for (const result of results) {
    const failure = judgeToolchainResult(result, options.nodeMajorFloor);
    if (failure) failures.push(failure);
  }

  return { ok: failures.length === 0, failures };
}

export {
  REQUIRED_DARWIN_PATHS,
  REQUIRED_WINDOWS_PATHS,
  checkDesktopConfig,
  checkInstalledLayout,
  evaluateToolchainResults,
  requiredPathsFor,
  toolchainChecks,
};
