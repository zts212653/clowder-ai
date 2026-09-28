import { stripHarmlessRedirections, tokenizeSimpleShellCommand } from './native-effect-shell-tokenizer.mjs';
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

  if (args[1] === 'remove' && args.length === 3 && isTemporaryWorktreePath(args[2])) return args[2];
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

export function isGitRepositoryObservation(raw) {
  const args = gitCommandArgs(tokenizeSimpleShellCommand(raw));
  if (!args) return false;
  if (['rev-parse', 'rev-list'].includes(args[0])) return true;
  if (['status', 'ls-tree'].includes(args[0])) return true;
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

export function isRepositoryRefresh(raw) {
  return refreshesRepository(gitCommandArgs(tokenizeSimpleShellCommand(raw)));
}

function refreshesRepository(args) {
  if (!args || args[0] !== 'fetch') return false;
  const fetchArgs = args.slice(1).filter((token) => !['--quiet', '-q', '--no-tags'].includes(token));
  if (fetchArgs.length !== 2 || fetchArgs[0] !== 'origin') return false;
  if (fetchArgs[1] === 'main') return true;
  const pullRefspec = fetchArgs[1].match(/^(?:refs\/)?pull\/(\d+)\/head:refs\/remotes\/origin\/pr\/(\d+)$/);
  return pullRefspec !== null && pullRefspec[1] === pullRefspec[2];
}

/** Git's own selectors, peeled off an operand list to reach the subcommand. */
function gitSubcommandArgs(operands) {
  let index = 0;
  while (index < operands.length) {
    const token = operands[index];
    if (token === '-C' || token === '-c') {
      if (operands[index + 1] === undefined) return null;
      index += 2;
      continue;
    }
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  return operands.slice(index);
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

export function isConstrainedGhPullRequestRead(raw) {
  return constrainedGhPullRequestOperation(raw)?.effect === 'read';
}

/**
 * Parse GitHub PR operations whose effect and remote target are structurally known.
 * Matching this narrow shape assigns the remote coordinate; it is not a global
 * allow/deny list. Unmatched shapes retain normal cwd/target classification, while
 * task custody, review, merge-gate, and operator boundaries remain authoritative.
 */
export function constrainedGhPullRequestOperation(raw) {
  const tokens = tokenizeSimpleShellCommand(raw);
  if (!tokens || tokens[0] !== 'gh' || tokens[1] !== 'pr') return null;
  const invocation = parseGhPullRequestInvocation(tokens);
  if (!invocation) return null;
  const flags = parseConstrainedGhFlags(
    tokens.slice(invocation.flagIndex),
    ghPullRequestFlagContract(invocation.subcommand),
  );
  if (!flags || !hasResolvableGhPullRequestCoordinate(invocation.subcommand, flags)) return null;

  const repo = flags.get('--repo');
  const repository = typeof repo === 'string' ? repo : 'current';
  return {
    effect: ['merge', 'close'].includes(invocation.subcommand) ? 'remote_mutation' : 'read',
    target: `github://${repository}/${invocation.pullNumber ? `pull/${invocation.pullNumber}` : 'pulls'}`,
  };
}

function parseGhPullRequestInvocation(tokens) {
  const subcommand = tokens[2];
  if (!['view', 'checks', 'list', 'merge', 'close'].includes(subcommand)) return null;
  if (subcommand === 'list') return { subcommand, flagIndex: 3 };
  const pullNumber = tokens[3];
  const hasValidPullNumber =
    subcommand === 'close' ? /^[1-9]\d*$/.test(pullNumber ?? '') : /^\d+$/.test(pullNumber ?? '');
  return hasValidPullNumber ? { subcommand, pullNumber, flagIndex: 4 } : null;
}

function hasResolvableGhPullRequestCoordinate(subcommand, flags) {
  if (subcommand !== 'merge') return true;
  return flags.has('--squash') && (!flags.has('--admin') || flags.has('--match-head-commit'));
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

function isTemporaryWorktreePath(raw) {
  return /^\/(?:private\/)?tmp\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw);
}

function ghPullRequestFlagContract(subcommand) {
  if (subcommand === 'view') {
    return { booleans: new Set(['--comments']), values: new Set(['--repo', '-R', '--json', '--jq', '--template']) };
  }
  if (subcommand === 'list') {
    return {
      booleans: new Set(['--draft']),
      values: new Set([
        '--repo',
        '-R',
        '--app',
        '--assignee',
        '--author',
        '--base',
        '--head',
        '--json',
        '--jq',
        '--label',
        '--limit',
        '--search',
        '--state',
        '--template',
      ]),
    };
  }
  if (subcommand === 'merge') {
    return {
      booleans: new Set(['--admin', '--delete-branch', '-d', '--squash', '-s']),
      values: new Set(['--repo', '-R', '--match-head-commit']),
    };
  }
  if (subcommand === 'close') {
    return { booleans: new Set(), values: new Set(['--repo', '-R']) };
  }
  return {
    booleans: new Set(['--required', '--watch', '--fail-fast']),
    values: new Set(['--repo', '-R', '--json', '--jq', '--template', '--interval']),
  };
}

function parseConstrainedGhFlags(tokens, contract) {
  const parsed = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    const normalized = normalizeGhFlag(flag);
    if (parsed.has(normalized)) return null;
    if (contract.booleans.has(flag)) {
      parsed.set(normalized, true);
      continue;
    }
    const value = tokens[index + 1];
    if (!contract.values.has(flag) || value === undefined || !isValidGhFlagValue(normalized, value)) return null;
    parsed.set(normalized, value);
    index += 1;
  }
  return parsed;
}

function normalizeGhFlag(flag) {
  if (flag === '-R') return '--repo';
  if (flag === '-d') return '--delete-branch';
  if (flag === '-s') return '--squash';
  return flag;
}

function isValidGhFlagValue(flag, value) {
  if (flag === '--repo') return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
  if (flag === '--interval') return /^\d+$/.test(value);
  if (flag === '--limit') return /^[1-9]\d*$/.test(value);
  if (flag === '--state') return ['open', 'closed', 'merged', 'all'].includes(value);
  if (flag === '--match-head-commit') return /^[0-9a-f]{40,64}$/i.test(value);
  return true;
}
