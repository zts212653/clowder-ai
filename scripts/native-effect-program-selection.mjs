import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve, sep } from 'node:path';
import { commandName } from './native-effect-shell-tokenizer.mjs';
import { classifyNativeTarget } from './native-effect-target-classifier.mjs';

// Exact reviewed repository wrapper, not a name-based exemption for runtime code.
const GH_WRAPPER_SHA256 = '112c1a192943829274eb82d8017da317ccb1fc671d79841311e9af64753cbb7c';
const ordinary = (path) => classifyNativeTarget(path, undefined, 'unknown').kind === 'ordinary';
const literal = (value) => typeof value === 'string' && !/[$`*?[\]{}\n\r]/.test(value);

function environmentValue(environment, name) {
  const assignment = environment?.findLast((word) => word.startsWith(`${name}=`));
  return assignment === undefined ? process.env[name] : assignment.slice(name.length + 1);
}

/** Observe the first executable, including symlinks. Never run it to classify it. */
function selectedExecutable(program, path, cwd) {
  if (!literal(program) || typeof path !== 'string') return null;
  return program.includes('/') ? selectedDirectExecutable(program, cwd) : selectedPathExecutable(program, path);
}

function selectedDirectExecutable(program, cwd) {
  if (hasParentSegment(program) || (!isAbsolute(program) && (!cwd || !isAbsolute(cwd) || hasParentSegment(cwd)))) {
    return null;
  }
  const observed = executableIdentity(isAbsolute(program) ? program : unresolvedChild(cwd, program));
  return observed.status === 'selected' ? observed.value : null;
}

function selectedPathExecutable(program, path) {
  for (const entry of path.split(delimiter)) {
    // Shell lookup stops at the first executable. A malformed or relative PATH
    // entry before that point makes selection ambiguous; entries after it are
    // unreachable and cannot invalidate an already-observed selection.
    if (!literal(entry) || !isAbsolute(entry) || hasParentSegment(entry)) return null;
    const observed = executableIdentity(unresolvedChild(entry, program));
    if (observed.status === 'unknown') return null;
    if (observed.status === 'selected') return observed.value;
  }
  return null;
}

function unresolvedChild(parent, child) {
  // Do not introduce lexical normalization before the filesystem observes the
  // candidate. Parent traversal is rejected separately because realpath may
  // collapse `symlink/..` differently from the kernel's executable lookup.
  return `${parent}${parent.endsWith(sep) ? '' : sep}${child}`;
}

function hasParentSegment(path) {
  return path.split(/[\\/]/).includes('..');
}

function executableIdentity(candidate) {
  try {
    if (!statSync(candidate).isFile()) return { status: 'missing' };
    accessSync(candidate, constants.X_OK);
    return { status: 'selected', value: { path: candidate, realpath: realpathSync(candidate) } };
  } catch (error) {
    return { status: ['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code) ? 'missing' : 'unknown' };
  }
}

function ordinarySelection(selected) {
  return selected && ordinary(selected.path) && ordinary(selected.realpath);
}

function ordinaryExecutableChain(selected, path, cwd, seen = new Set()) {
  if (!ordinarySelection(selected) || seen.size >= 4 || seen.has(selected.realpath)) return false;
  seen.add(selected.realpath);
  let fd;
  try {
    fd = openSync(selected.realpath, 'r');
    const prefix = Buffer.alloc(512);
    const count = readSync(fd, prefix, 0, prefix.length, 0);
    if (prefix[0] !== 35 || prefix[1] !== 33) return true;
    const line = prefix.subarray(2, count).toString().split('\n')[0].trim();
    const [interpreter, ...args] = line.split(/\s+/);
    if (!isAbsolute(interpreter)) return false;
    const resolved = selectedExecutable(interpreter, path, cwd);
    if (!ordinarySelection(resolved)) return false;
    if (commandName(interpreter) !== 'env') return ordinaryExecutableChain(resolved, path, cwd, seen);
    if (args.length !== 1 || args[0].startsWith('-')) return false;
    return ordinaryExecutableChain(selectedExecutable(args[0], path, cwd), path, cwd, seen);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function verifiedGhWrapper(selected, call, path) {
  if (commandName(call.program) !== 'gh') return null;
  try {
    if (createHash('sha256').update(readFileSync(selected.realpath)).digest('hex') !== GH_WRAPPER_SHA256) return null;
    const node = selectedExecutable('node', path, call.cwd);
    if (!ordinaryExecutableChain(node, path, call.cwd)) return null;
    const delegatePath = path
      .split(delimiter)
      .filter((entry) => resolve(entry) !== dirname(selected.realpath))
      .join(delimiter);
    const delegate = environmentValue(call.environment, 'CAT_CAFE_REAL_GH_PATH') ?? 'gh';
    const gh = selectedExecutable(delegate, delegatePath, call.cwd);
    if (!ordinaryExecutableChain(gh, delegatePath, call.cwd)) return null;
    // The pinned wrapper may inspect git metadata before delegating PR creation.
    const git = selectedExecutable('git', path, call.cwd);
    if (!ordinaryExecutableChain(git, path, call.cwd)) return null;
    return { kind: 'repository_gh_wrapper', executable: selected, interpreter: node, delegate: gh, git };
  } catch {
    return null;
  }
}

/** PATH can leave target text only after its actual program selection is observed.
 * This is role evidence, never a sandbox, effect, or future execution certificate.
 */
export function proveProgramSelection(call) {
  for (const wrapper of call.wrappers ?? []) {
    // Other wrappers can change PATH/identity; keep their original conservative text.
    if (commandName(wrapper.program) !== 'env' || wrapper.options.some((word) => word !== '--')) return null;
    const selected = selectedExecutable(wrapper.program, environmentValue(wrapper.environment, 'PATH'), wrapper.cwd);
    if (!ordinaryExecutableChain(selected, environmentValue(wrapper.environment, 'PATH'), wrapper.cwd)) return null;
  }
  const path = environmentValue(call.environment, 'PATH');
  const selected = selectedExecutable(call.program, path, call.cwd);
  if (!selected) return null;
  return ordinaryExecutableChain(selected, path, call.cwd)
    ? { kind: 'ordinary_executable', executable: selected }
    : verifiedGhWrapper(selected, call, path);
}
