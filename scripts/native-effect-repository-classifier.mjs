export {
  constrainedGhPullRequestOperation,
  isConstrainedGhPullRequestRead,
} from './native-effect-github-classifier.mjs';

import { gitSubcommandArgs, isTemporaryWorktreePath, worktreeRemovalOperand } from './lib/git-invocation.mjs';
import { executedInvocations } from './lib/shell-invocation.mjs';

export { gitSubcommandArgs, worktreeRemovalOperand } from './lib/git-invocation.mjs';

import { fetchRefRoles } from './native-effect-git-fetch.mjs';
import {
  shellInvocation,
  stripHarmlessRedirections,
  tokenizeSimpleShellCommand,
} from './native-effect-shell-tokenizer.mjs';
import { namesRuntimeBranch } from './native-effect-target-classifier.mjs';

/**
 * Return the explicit filesystem target for a narrowly parsed temporary worktree lifecycle.
 * The source repository may be the passive runtime checkout; it is not the checkout destination.
 */
export function explicitTemporaryWorktreeTarget(raw) {
  const args = gitCommandArgs(tokenizeSimpleShellCommand(stripHarmlessRedirections(raw)));
  if (!args || args[0] !== 'worktree') return null;

  if (args[1] === 'add') {
    const operands = args.slice(2).filter((token) => token !== '--detach');
    const options = args.slice(2).filter((token) => token.startsWith('-'));
    if (options.some((option) => option !== '--detach') || operands.length !== 2) return null;
    const [target, revision] = operands;
    const exactRevision = /^[0-9a-f]{40,64}$/i.test(revision);
    const detachedTrackingRevision = options.includes('--detach') && revision === 'origin/main';
    return isTemporaryWorktreePath(target) && (exactRevision || detachedTrackingRevision) ? target : null;
  }

  const removal = worktreeRemovalOperand(args);
  if (args[1] === 'remove' && removal && isTemporaryWorktreePath(removal)) return removal;
  return null;
}

export function isRepositoryRewrite(raw) {
  return (
    (isGitFetchCommand(raw) && !isRepositoryRefresh(raw)) ||
    /\bgit\b[^\n;&|]*\b(reset\s+--hard|push\b[^\n;&|]*(?:--force|-f\b)|branch\b[^\n;&|]*(?:-[dDmM]\b|--delete|--move)|update-ref\b[^\n;&|]*-d\b|worktree\s+remove)\b/i.test(
      raw,
    ) ||
    /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(?:--delete\b|-d\b|(?:^|\s):[^\s;&|]+|(?:^|\s)\+[^\s;&|]+)/i.test(raw) ||
    (namesRuntimeBranch(raw) &&
      /\bgit\b[^\n;&|]*\b(checkout|switch|merge|rebase|push|pull|update-ref|branch)\b/i.test(raw))
  );
}

export function isGitWriteOperation(raw) {
  const args = gitCommandArgs(tokenizeSimpleShellCommand(raw));
  return Boolean(
    args &&
      (['add', 'commit', 'merge', 'rebase', 'checkout', 'switch', 'push', 'pull', 'cherry-pick', 'stash'].includes(
        args[0],
      ) ||
        (args[0] === 'worktree' && args[1] === 'add')),
  );
}

export function isGitRepositoryObservation(raw, operandIsData = () => true) {
  const args = gitCommandArgs(tokenizeSimpleShellCommand(raw));
  if (!args) return false;
  if (['rev-parse', 'rev-list'].includes(args[0])) return true;
  if (['status', 'ls-tree'].includes(args[0])) return true;
  if (args[0] === 'grep')
    return knownReadOptions(
      args.slice(1),
      GREP_READ_FLAGS,
      GREP_READ_VALUES,
      'nHhilLcvoqwbFEGPIa',
      'efABC',
      operandIsData,
    );
  if (args[0] === 'cat-file')
    return knownReadOptions(args.slice(1), CAT_FILE_READ_FLAGS, new Set(['--path']), 'tsep', '', operandIsData);
  if (args[0] === 'branch' && args.length === 2 && args[1] === '--show-current') return true;
  if (
    args[0] === 'merge-base' &&
    args.length === 4 &&
    args[1] === '--is-ancestor' &&
    args.slice(2).every(isSafeGitObjectName)
  ) {
    return true;
  }
  return (
    args[0] === 'ls-remote' &&
    args.length >= 2 &&
    args.length <= 3 &&
    args[1] === 'origin' &&
    (args.length === 2 || ['main', 'refs/heads/main'].includes(args[2]) || isGitHubPullHeadRef(args[2]))
  );
}

const GREP_READ_FLAGS = new Set([
  '--cached',
  '--no-index',
  '--untracked',
  '--exclude-standard',
  '--no-exclude-standard',
  '--recurse-submodules',
  '--ignore-case',
  '--word-regexp',
  '--invert-match',
  '--full-name',
  '--line-number',
  '--column',
  '--files-with-matches',
  '--files-without-match',
  '--count',
  '--quiet',
  '--all-match',
  '--and',
  '--or',
  '--not',
  '--extended-regexp',
  '--basic-regexp',
  '--fixed-strings',
  '--perl-regexp',
  '--text',
  '--binary-files',
  '--color',
  '--no-color',
  '--heading',
  '--break',
  '--null',
]);
const GREP_READ_VALUES = new Set([
  '--regexp',
  '--file',
  '--max-count',
  '--before-context',
  '--after-context',
  '--context',
  '--threads',
]);
const CAT_FILE_READ_FLAGS = new Set([
  '--batch',
  '--batch-check',
  '--batch-command',
  '--batch-all-objects',
  '--buffer',
  '--unordered',
  '--allow-unknown-type',
  '--follow-symlinks',
  '--use-mailmap',
  '--no-use-mailmap',
]);

/** Exact option grammar: abbreviations and short clusters cannot hide a pager/filter. */
function knownReadOptions(args, flags, values, shortFlags, shortValues, operandIsData) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') return true;
    // An opaque word here can become an option. Consumed option values and words
    // after `--` are data positions regardless of their generated contents.
    if (!token.startsWith('-') || token === '-') {
      if (!operandIsData(token)) return false;
      continue;
    }
    if (token.startsWith('--')) {
      const option = token.split('=', 1)[0];
      if (values.has(option)) {
        if (!token.includes('=') && args[++index] === undefined) return false;
      } else if (!flags.has(option)) return false;
      continue;
    }
    for (let cursor = 1; cursor < token.length; cursor += 1) {
      if (shortValues.includes(token[cursor])) {
        if (cursor === token.length - 1 && args[++index] === undefined) return false;
        break;
      }
      if (!shortFlags.includes(token[cursor])) return false;
    }
  }
  return true;
}

export function isRepositoryRefresh(raw) {
  const command = stripHarmlessRedirections(raw);
  const parsed = shellInvocation(command);
  // A stripped wrapper/assignment is not an execution-environment certificate.
  // Git env variables can execute SSH/proxy/askpass helpers, including for fetch.
  if (!parsed.complete || parsed.redirections.length || parsed.words[0]?.value !== 'git') return false;
  const execution = executedInvocations(command);
  const commands = execution.pipelines.flat();
  return (
    execution.complete &&
    commands.length === 1 &&
    commands[0].name === 'git' &&
    refreshesRepository(gitCommandArgs(['git', ...commands[0].operands]))
  );
}

/**
 * Git's own rule, not a list of shapes: a fetch only rewrites a ref when it is forced
 * (`--force`, a `+` refspec) or writes outside `refs/remotes/` (`src:refs/heads/main`).
 * Everything else updates FETCH_HEAD and remote-tracking refs. Until 2026-09-27 only
 * `fetch origin main` and one pull-refspec shape counted as a refresh, so
 * `git fetch origin feat/x main` was denied as a rewrite of main.
 */
function refreshesRepository(args) {
  return fetchRefRoles(args)?.refresh === true;
}

const BRANCH_REWRITE_FLAGS = new Set(['-d', '-D', '-m', '-M', '--delete', '--move']);
const RUNTIME_BRANCH_SUBCOMMANDS = new Set([
  'checkout',
  'switch',
  'merge',
  'rebase',
  'push',
  'pull',
  'update-ref',
  'branch',
]);

/**
 * Split a subcommand's operands by the role `--` gives them.
 *
 * `--` ends the *option parsing*, and nothing more general than that: what a
 * positional operand then means is each subcommand's own business, so this
 * only reports the roles and lets the caller decide which one it uses.
 *
 * - `options`: only what precedes `--`. `git reset -- --hard` names a path,
 *   so it is a path-scoped reset of index entries, not a working-tree hard
 *   reset. (It is not a no-op; it is simply not the destructive form.)
 * - `refs`: the positional operands on both sides, because a refspec keeps its
 *   meaning after `--` -- `git push origin -- +main:main` still force-pushes.
 * - `namedBeforeEndOfOptions`: for a subcommand whose trailing operand is a
 *   pathspec rather than a ref. `git checkout -- <name>` restores a file and
 *   leaves HEAD alone, while `git checkout <name>` moves onto the branch. That
 *   is checkout's own form; `git switch -- <name>` still switches.
 */
function argvRoles(rest) {
  const end = rest.indexOf('--');
  const head = end < 0 ? rest : rest.slice(0, end);
  const tail = end < 0 ? [] : rest.slice(end + 1);
  const options = head.filter((token) => token.startsWith('-'));
  const namedBeforeEndOfOptions = head.filter((token) => !token.startsWith('-'));
  return { options, namedBeforeEndOfOptions, refs: [...namedBeforeEndOfOptions, ...tail] };
}

/**
 * Does this Git *argv* rewrite the repository?
 *
 * Anchored on the subcommand Git would actually run. Naming the executable is
 * not the same as reading its arguments: `git grep "git reset --hard"` runs
 * `grep`, and the words after it are the pattern it searches for -- which is
 * exactly the read someone uses to inspect the rule being guarded here.
 */
export function gitArgvRewritesRepository(operands) {
  const args = gitSubcommandArgs(operands ?? []);
  if (!args || args.length === 0) return false;
  const [subcommand, ...rest] = args;
  const { options, namedBeforeEndOfOptions, refs } = argvRoles(rest);

  if (subcommand === 'fetch') return !refreshesRepository(args);
  if (subcommand === 'reset') return options.includes('--hard');
  if (subcommand === 'update-ref') return options.includes('-d');
  if (subcommand === 'worktree') return rest[0] === 'remove';
  if (subcommand === 'branch' && options.some((token) => BRANCH_REWRITE_FLAGS.has(token))) return true;
  if (subcommand === 'push') {
    if (options.some((token) => token.startsWith('--force') || ['-f', '--delete', '-d'].includes(token))) return true;
    if (refs.some((token) => /^[:+]/.test(token))) return true;
  }
  if (!RUNTIME_BRANCH_SUBCOMMANDS.has(subcommand)) return false;
  // `checkout` is the only one of these with a pathspec form: after `--` it
  // restores files and leaves HEAD alone. `switch` has no such mode -- `--`
  // only ends its options, and it still moves onto the branch named after it.
  const named = subcommand === 'checkout' ? namedBeforeEndOfOptions : refs;
  return named.some((token) => namesRuntimeBranch(token));
}

function isGitFetchCommand(raw) {
  return gitCommandArgs(tokenizeSimpleShellCommand(raw))?.[0] === 'fetch';
}

/** Peel off Git's repository selector without weakening classification of its subcommand. */
function gitCommandArgs(tokens) {
  if (!tokens || tokens[0] !== 'git') return null;
  let index = 1;
  while (tokens[index] === '-C') {
    if (!tokens[index + 1]) return null;
    index += 2;
  }
  return tokens.slice(index);
}

function isSafeGitObjectName(raw) {
  return /^(?:[0-9a-f]{7,64}|(?:refs\/)?[A-Za-z0-9][A-Za-z0-9._/-]*|HEAD(?:~\d+|\^\d*)?)$/i.test(raw);
}

function isGitHubPullHeadRef(raw) {
  return /^(?:refs\/)?pull\/\d+\/head$/.test(raw);
}
