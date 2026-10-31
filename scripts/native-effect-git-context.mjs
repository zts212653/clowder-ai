import { isAbsolute, relative, resolve, sep } from 'node:path';
import { kernelPath, unfoldedJoin } from './lib/shell-directory.mjs';
import { tokenizeSimpleShellCommand } from './native-effect-shell-tokenizer.mjs';
import { classifyNativeTarget, namesRuntimeBranch } from './native-effect-target-classifier.mjs';

const EFFECT = 'repository_rewrite';
const BRANCH_DELETE_FLAGS = new Set(['-d', '-D', '--delete']);
const EXPLICIT_RELATIVE_PATH = sep === '\\' ? /^\.\.?(?:[/\\]|$)/ : /^\.\.?(?:\/|$)/;

/**
 * `cd` and `git -C` choose the directory a Git mutation runs in; they are not what
 * it mutates. Scanning the whole command text reads them as the target, so removing
 * a sibling worktree from the main checkout was denied as a delete of the checkout.
 *
 * This branch-deletion path parses `git branch -d|-D|--delete <name>...` in its
 * actual directory. Worktree removal uses native-effect-worktree-removal.mjs,
 * whose execution reader resolves wrapper and Git selectors before calling
 * the physical worktreeRemoveCandidate below.
 *
 * Coordinates follow who resolves them. Git and the kernel chdir() into `-C`
 * operands and open the worktree path component by component, so a symlink is
 * followed before the `..` after it: `alias/..` is the parent of the link's target,
 * not the directory holding the link. A shell `cd` is logical by default (`..`
 * drops the previous path text) but physical under `cd -P` or CHASE_LINKS; the
 * guard cannot know which one runs, so it keeps both readings and denies if either
 * reaches a protected target.
 *
 * Returns null for anything else, and the caller keeps its text-based, fail-closed
 * classification. That includes any separator other than `&&`, unsupported options,
 * shell expansion, globs, or a directory that does not physically exist.
 */
export function contextualGitMutationCandidates(raw, cwd) {
  const parts = splitAndChain(raw);
  if (!parts || typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  const chain = leadingCdChain(parts);
  const locations = chain ? shellLocations(cwd, chain.cdOperands) : null;
  if (!locations) return null;
  const candidates = [];
  for (const part of chain.mutations) {
    const candidate = gitMutationCandidate(tokenizeSimpleShellCommand(part), locations);
    if (!candidate) return null;
    candidates.push(candidate);
  }
  return candidates;
}

/** `cd <dir> && ... && <mutation> && ...`: the leading `cd` operands, then everything after. */
function leadingCdChain(parts) {
  const cdOperands = [];
  let index = 0;
  for (; index < parts.length; index += 1) {
    const tokens = tokenizeSimpleShellCommand(parts[index]);
    if (!tokens || tokens[0] !== 'cd') break;
    if (tokens.length !== 2 || !isLiteralOperand(tokens[1])) return null;
    cdOperands.push(tokens[1]);
  }
  const mutations = parts.slice(index);
  return mutations.length > 0 ? { cdOperands, mutations } : null;
}

/** Every directory the shell may be in after the `cd`s: logical and physical readings. */
function shellLocations(cwd, operands) {
  const start = kernelPath(cwd);
  if (!start) return null;
  let locations = [{ logical: cwd, physical: start }];
  for (const operand of operands) {
    const next = new Map();
    for (const location of locations) {
      const logical = resolve(location.logical, operand);
      const physicalCd = kernelPath(unfoldedJoin(location.physical, operand));
      for (const reading of [
        { logical, physical: kernelPath(logical) },
        { logical: physicalCd, physical: physicalCd },
      ]) {
        if (!reading.physical) return null;
        next.set(`${reading.logical}\0${reading.physical}`, reading);
      }
    }
    locations = [...next.values()];
  }
  return locations;
}

function gitMutationCandidate(tokens, locations) {
  const invocation = gitInvocation(tokens, locations);
  if (!invocation) return null;
  const { args, runtimeContext } = invocation;
  const branchDelete = args[0] === 'branch' && BRANCH_DELETE_FLAGS.has(args[1]);
  if (!branchDelete) return null;
  if (runtimeContext) return candidate('runtime_sanctuary', runtimeContext);
  return args.length > 2 ? branchDeleteCandidate(args.slice(2), invocation) : null;
}

/** Git chdir()s into each `-C` operand, so the kernel resolves it from the physical cwd. */
function gitInvocation(tokens, locations) {
  if (!tokens || tokens[0] !== 'git') return null;
  let directories = locations.map((location) => location.physical);
  let lexical = locations.map((location) => location.logical);
  let index = 1;
  while (tokens[index] === '-C') {
    const operand = tokens[index + 1];
    if (!isLiteralOperand(operand)) return null;
    directories = directories.map((directory) => kernelPath(unfoldedJoin(directory, operand)));
    lexical = lexical.map((directory) => resolve(directory, operand));
    if (directories.some((directory) => !directory)) return null;
    index += 2;
  }
  // Physical paths are canonical; the lexical reading also catches a runtime path that is itself a link.
  const runtimeContext = [...directories, ...lexical].find((path) => targetKind(path) === 'runtime_sanctuary');
  return { args: tokens.slice(index), directories, runtimeContext };
}

export function worktreeRemoveCandidate(operand, { directories }) {
  // Option parsing already established the operand; after `--`, a leading dash is literal.
  if (typeof operand !== 'string' || operand.length === 0 || /[$~*?[\]{}]/.test(operand)) return null;
  // Git tries registered-worktree suffixes before cwd-relative paths. A suffix
  // can select another worktree even when a same-named local directory exists.
  // Absolute or explicitly dot-relative paths cannot match a canonical suffix.
  if (!isAbsolute(operand) && !EXPLICIT_RELATIVE_PATH.test(operand)) return null;
  let ordinary = null;
  for (const directory of directories) {
    const target = kernelPath(unfoldedJoin(directory, operand));
    if (!target) return null;
    // Removing the checkout, or any directory that contains it, deletes the repository itself.
    if (containsOrEquals(target, directory)) return candidate('broad_root', target);
    const kind = [target, resolve(directory, operand)].map(targetKind).find((k) => k !== 'ordinary');
    if (kind) return candidate(kind, target);
    ordinary ??= candidate('ordinary', target);
  }
  return ordinary;
}

function branchDeleteCandidate(names, { directories }) {
  if (!names.every(isLiteralBranchName)) return null;
  const protectedName = names.find(isProtectedBranchName);
  if (protectedName) return candidate('protected_branch', protectedName);
  return candidate('ordinary', `${directories[0]}#${names.join(',')}`);
}

/** Split on `&&` only; any other separator, subshell, or expansion is not modeled here. */
function splitAndChain(raw) {
  if (typeof raw !== 'string' || /`|\$\(|[<>]\(/.test(raw)) return null;
  const parts = [];
  const scan = { quote: null, escaped: false };
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (!scanUnquotedOperator(scan, raw[index])) continue;
    if (raw[index] !== '&' || raw[index + 1] !== '&') return null;
    parts.push(raw.slice(start, index).trim());
    start = index + 2;
    index += 1;
  }
  if (scan.quote || scan.escaped) return null;
  parts.push(raw.slice(start).trim());
  return parts.every(Boolean) ? parts : null;
}

/** Advance quote/escape state; true when `char` is an unquoted shell operator character. */
function scanUnquotedOperator(scan, char) {
  if (scan.escaped) {
    scan.escaped = false;
    return false;
  }
  if (char === '\\' && scan.quote !== "'") {
    scan.escaped = true;
    return false;
  }
  if (scan.quote) {
    if (char === scan.quote) scan.quote = null;
    return false;
  }
  if (char === "'" || char === '"') {
    scan.quote = char;
    return false;
  }
  return ';&|\n\r()<>'.includes(char);
}

function isLiteralOperand(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-') && !/[$~*?[\]{}]/.test(value);
}

function isLiteralBranchName(value) {
  return isLiteralOperand(value) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && value !== 'HEAD';
}

function isProtectedBranchName(name) {
  const branch = name.replace(/^refs\/heads\//, '');
  return /^(?:main|master)$/i.test(branch) || namesRuntimeBranch(branch);
}

function targetKind(path) {
  return classifyNativeTarget(path, undefined, EFFECT, path).kind;
}

function containsOrEquals(candidateAncestor, path) {
  const fromAncestor = relative(candidateAncestor, path);
  const outside = fromAncestor === '..' || fromAncestor.startsWith(`..${sep}`) || isAbsolute(fromAncestor);
  return !outside;
}

function candidate(kind, value) {
  return { effect: EFFECT, target: { kind, value } };
}
