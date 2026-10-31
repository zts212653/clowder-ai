// Deployment identity for the direct launcher's complete build transaction.
// Stamps are disposable build metadata, never runtime/user storage.
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const { constants } = require('node:os');

const PRODUCTS = Object.freeze({
  shared: 'packages/shared/dist/index.js',
  'mcp-server': 'packages/mcp-server/dist/index.js',
  api: 'packages/api/dist/index.js',
  web: 'packages/web/.next/BUILD_ID',
});
const INPUTS = Object.freeze([
  'packages',
  'scripts',
  'tsconfig.base.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
]);
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const observedNamespaces = new WeakMap();

function mixedNamespace(directory) {
  return /^packages\/[^/]+$/.test(directory) || directory === 'packages/web/public';
}

function generatedSibling(directory, name) {
  if (/^packages\/[^/]+$/.test(directory)) {
    return name === 'dist' || name === '.next' || /^[^/]+\.tsbuildinfo$/.test(name);
  }
  return name === 'vendor' || /^(?:sw\.js|(?:workbox-|swe-worker-|worker-).+\.js)(?:\.map)?$/.test(name);
}

function stampPath(root, pkg) {
  return path.join(path.dirname(path.resolve(root, PRODUCTS[pkg])), '.build-commit');
}

function invalidateBuildIdentity(root) {
  for (const pkg of Object.keys(PRODUCTS)) rmSync(stampPath(root, pkg), { force: true });
}

function captureBuildState(root) {
  try {
    const git = (args) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const revision = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const dirty = () => git(['status', '--porcelain', '--untracked-files=all', '--', ...INPUTS]);
    if (!FULL_COMMIT.test(revision) || dirty()) return null;
    const hash = createHash('sha256');
    const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...INPUTS])
      .split('\0')
      .filter(Boolean);
    const directories = new Set();
    const namespaces = {};
    for (const file of files) {
      const stat = lstatSync(path.resolve(root, file), { bigint: true });
      hash.update(JSON.stringify([file, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]));
      // File epochs alone miss a new input that is consumed and then moved
      // away. Its nearest pre-existing source directory retains that change,
      // including when an entire new source subtree is added and removed.
      // Do not descend into ignored output trees or include the workspace root
      // (which also contains unrelated logs and retained test evidence).
      for (let directory = path.dirname(file); directory !== '.'; directory = path.dirname(directory)) {
        directories.add(directory);
      }
    }
    for (const directory of [...directories].sort()) {
      const stat = lstatSync(path.resolve(root, directory), { bigint: true });
      const epoch = [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs].map(String);
      if (mixedNamespace(directory)) namespaces[directory] = epoch;
      else hash.update(JSON.stringify([directory, ...epoch]));
    }
    // The reflog's metadata observes normal HEAD moves-and-returns too. This
    // is detection, not an exclusive writer lock or a hermetic build promise.
    const reflog = path.resolve(root, git(['rev-parse', '--git-path', 'logs/HEAD']));
    if (existsSync(reflog)) {
      const stat = statSync(reflog, { bigint: true });
      hash.update(JSON.stringify([stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)));
    }
    if (dirty() || git(['rev-parse', '--verify', 'HEAD^{commit}']) !== revision) return null;
    return { revision, fingerprint: hash.digest('hex'), namespaces };
  } catch {
    return null; // Non-git or unreadable inputs can build, but cannot claim identity.
  }
}

function productState(root, pkg) {
  try {
    const stat = statSync(path.resolve(root, PRODUCTS[pkg]), { bigint: true });
    if (!stat.isFile() || stat.size === 0n) return null;
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
  } catch {
    return null;
  }
}

function readStamp(root, pkg) {
  try {
    return readFileSync(stampPath(root, pkg), 'utf8').trim();
  } catch {
    return null;
  }
}

function beginBuildIdentity(root) {
  // Establish the known build namespaces before observing source directories.
  // Creating dist/.next on a fresh checkout must not look like adding source;
  // subsequent writes within these ignored trees do not change their parents.
  for (const pkg of Object.keys(PRODUCTS))
    mkdirSync(path.dirname(path.resolve(root, PRODUCTS[pkg])), { recursive: true });
  const source = captureBuildState(root);
  const context = {
    root: path.resolve(root),
    revision: source?.revision ?? null,
    fingerprint: source?.fingerprint ?? null,
    namespaces: source?.namespaces ?? null,
    products: Object.fromEntries(
      Object.keys(PRODUCTS).map((pkg) => [
        pkg,
        {
          state: productState(root, pkg),
          revision: readStamp(root, pkg),
        },
      ]),
    ),
  };
  invalidateBuildIdentity(root);
  return context;
}

function finishBuildIdentity(root, context, packages) {
  const capturedRevision = context.revision;
  const source = captureBuildState(root);
  const valid =
    FULL_COMMIT.test(capturedRevision ?? '') &&
    context.root === path.resolve(root) &&
    source?.revision === capturedRevision &&
    source?.fingerprint === context.fingerprint &&
    JSON.stringify(source?.namespaces) === JSON.stringify(observedNamespaces.get(context) ?? context.namespaces) &&
    packages.length > 0 &&
    packages.every((pkg) => {
      if (!Object.hasOwn(PRODUCTS, pkg)) return false;
      const current = productState(root, pkg);
      const previous = context.products[pkg];
      // Incremental no-op is legitimate only for a previously proven artifact
      // at this exact revision. Existence alone cannot bless an old product.
      return (
        current &&
        (current !== previous.state || previous.revision === capturedRevision) &&
        (pkg !== 'web' || readStamp(root, pkg) === capturedRevision)
      );
    });
  if (!valid) {
    invalidateBuildIdentity(root);
    return false;
  }
  try {
    for (const pkg of packages) {
      const stamp = stampPath(root, pkg);
      const temp = `${stamp}.${process.pid}.tmp`;
      try {
        writeFileSync(temp, `${capturedRevision}\n`, { flag: 'wx' });
        renameSync(temp, stamp);
      } finally {
        rmSync(temp, { force: true });
      }
    }
    // Also guard a HEAD/input change while the small stamp set is published.
    const publishedSource = captureBuildState(root);
    if (
      publishedSource?.revision !== capturedRevision ||
      publishedSource?.fingerprint !== context.fingerprint ||
      JSON.stringify(publishedSource?.namespaces) !==
        JSON.stringify(observedNamespaces.get(context) ?? context.namespaces)
    ) {
      invalidateBuildIdentity(root);
      return false;
    }
    return true;
  } catch (error) {
    invalidateBuildIdentity(root);
    throw error;
  }
}

// One foreground owner observes the complete compiler interval. No detached
// watcher, polling snapshot or persistent event ledger is involved. Mixed
// source/output directories can change only through the declared generators;
// a transient new source there is observed even when it disappears by finish.
function namespacesObserved(before, after, seen) {
  if (!after || JSON.stringify(Object.keys(before)) !== JSON.stringify(Object.keys(after))) return false;
  return Object.entries(after).every(([directory, epoch]) => {
    const start = before[directory];
    return (
      JSON.stringify(epoch.slice(0, 2)) === JSON.stringify(start.slice(0, 2)) &&
      (JSON.stringify(epoch) === JSON.stringify(start) || seen.has(directory))
    );
  });
}

function signalCompilerGroup(pid, signal) {
  try {
    // This is only the group established by our detached-but-awaited spawn,
    // never the launcher's, caller's or runtime's inherited process group.
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function compilerGroupAlive(pid) {
  // kill(group, 0) on macOS can report EPERM for an already retired group.
  // Read only process coordinates/state; zombies cannot publish artifacts.
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .some((line) => {
      const [, group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !state.startsWith('Z');
    });
}

async function waitCompilerGroup(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (compilerGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function stopCompilerGroup(pid, signal) {
  if (!compilerGroupAlive(pid)) return;
  signalCompilerGroup(pid, signal);
  if (await waitCompilerGroup(pid, 750)) return;
  signalCompilerGroup(pid, 'SIGKILL');
  if (!(await waitCompilerGroup(pid, 2500))) throw new Error('owned compiler group did not stop');
}

function spawnOwnedCompiler(root, revision, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    // POSIX start-dev.sh: detached establishes ownership, not background work.
    // No unref; this foreground owner joins the entire group before returning.
    detached: true,
    env: { ...process.env, CAT_CAFE_WEB_BUILD_REVISION: revision ?? '' },
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
  });
  let interrupted;
  let discarded = false;
  let stopping;
  let stopError;
  const forward = (signal) => {
    interrupted ??= signal;
    invalidateBuildIdentity(root);
    if (child?.pid && !stopping) {
      stopping = stopCompilerGroup(child.pid, signal).catch((error) => {
        stopError = error;
      });
    }
  };
  const onInt = () => forward('SIGINT');
  const onTerm = () => forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return {
    get untrusted() {
      return Boolean(interrupted) || discarded;
    },
    status(code) {
      return interrupted ? 128 + constants.signals[interrupted] : code;
    },
    async wait() {
      const status = await exited;
      await stopping;
      if (stopError) throw stopError;
      // Shell completion is not tree completion, even when its exit was zero.
      if (child.pid && compilerGroupAlive(child.pid)) {
        discarded = true;
        await stopCompilerGroup(child.pid, 'SIGTERM');
      }
      return status;
    },
    async close() {
      try {
        await stopping;
        if (child.pid && compilerGroupAlive(child.pid)) {
          discarded = true;
          await stopCompilerGroup(child.pid, 'SIGTERM');
        }
      } finally {
        if (interrupted || discarded || stopError) invalidateBuildIdentity(root);
        process.removeListener('SIGINT', onInt);
        process.removeListener('SIGTERM', onTerm);
      }
    },
  };
}

async function runBuildIdentity(root, packages, command, args) {
  const context = beginBuildIdentity(root);
  const watchers = [];
  let sourceChanged = false;
  const seenNamespaces = new Set();
  let compiler;
  let status;
  try {
    for (const directory of Object.keys(context.namespaces ?? {})) {
      const observer = watch(path.resolve(root, directory), (_event, filename) => {
        seenNamespaces.add(directory);
        if (!filename || !generatedSibling(directory, String(filename))) sourceChanged = true;
      });
      observer.on('error', () => {
        sourceChanged = true;
      });
      watchers.push(observer);
    }
    const ready = captureBuildState(root);
    if (JSON.stringify(ready?.namespaces) !== JSON.stringify(context.namespaces)) sourceChanged = true;
    compiler = spawnOwnedCompiler(root, context.revision, command, args);
    status = await compiler.wait();
    // Drain queued OS notifications while the watchers are still live. A
    // changed directory with no observation is unknown, never generator proof.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const end = captureBuildState(root);
    if (!namespacesObserved(context.namespaces ?? {}, end?.namespaces, seenNamespaces)) sourceChanged = true;
    if (sourceChanged || compiler.untrusted) context.revision = null;
    else observedNamespaces.set(context, end?.namespaces);
    if (status !== 0 || !finishBuildIdentity(root, context, packages)) {
      invalidateBuildIdentity(root);
      if (status === 0)
        console.warn('[build] deployment identity unavailable: inputs changed or observation incomplete');
    }
  } finally {
    try {
      await compiler?.close();
    } finally {
      for (const observer of watchers) observer.close();
    }
  }
  return compiler.status(status);
}

module.exports = {
  PRODUCTS,
  INPUTS,
  beginBuildIdentity,
  invalidateBuildIdentity,
  finishBuildIdentity,
  runBuildIdentity,
  stampPath,
};

if (require.main === module) {
  const [action, root, revision, ...packages] = process.argv.slice(2);
  if (action === 'run') {
    const [selected, command, ...args] = [revision, ...packages];
    runBuildIdentity(root, selected.split(','), command, args).then(
      (status) => {
        process.exitCode = status;
      },
      (error) => {
        invalidateBuildIdentity(root);
        console.error(error);
        process.exitCode = 1;
      },
    );
  } else if (action === 'revision') {
    process.stdout.write(JSON.parse(root).revision ?? '');
  } else if (!root || !existsSync(path.resolve(root, 'package.json'))) {
    throw new Error('build identity requires a package root');
  } else if (action === 'begin') {
    process.stdout.write(JSON.stringify(beginBuildIdentity(root)));
  } else if (action === 'invalidate') {
    invalidateBuildIdentity(root);
  } else if (action === 'finish') {
    if (!finishBuildIdentity(root, JSON.parse(revision), packages)) {
      console.warn(
        '[build] deployment identity unavailable: missing products, dirty inputs or changed HEAD; stamps invalidated',
      );
    }
  } else {
    throw new Error(`unknown build identity action: ${action}`);
  }
}
