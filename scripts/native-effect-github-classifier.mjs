import { shellInvocation, tokenizeSimpleShellCommand } from './native-effect-shell-tokenizer.mjs';

const API_VALUES = new Map([
  ['--method', 'method'],
  ['-X', 'method'],
  ['--field', 'field'],
  ['-F', 'field'],
  ['--raw-field', 'field'],
  ['-f', 'field'],
  ['--header', 'header'],
  ['-H', 'header'],
  ['--jq', 'format'],
  ['-q', 'format'],
  ['--template', 'format'],
  ['-t', 'format'],
  ['--preview', 'preview'],
  ['-p', 'preview'],
  ['--hostname', 'hostname'],
]);
const API_FLAGS = new Set(['--include', '-i', '--paginate', '--silent', '--slurp', '--verbose']);

export function constrainedGhApiOperation(raw, { payloadFree = false } = {}) {
  const parsed = shellInvocation(raw);
  if (!parsed.complete || parsed.redirections.length) return null;
  const tokens = parsed.words.map(({ value }) => value);
  if (tokens[0] !== 'gh' || tokens[1] !== 'api') return null;
  let method,
    fields = false,
    endpoint;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) {
      if (endpoint) return null;
      endpoint = token;
      continue;
    }
    if (API_FLAGS.has(token)) continue;
    const equals = token.indexOf('=');
    const attached = !token.startsWith('--') && token.length > 2;
    const flag = attached ? token.slice(0, 2) : equals < 0 ? token : token.slice(0, equals);
    const role = API_VALUES.get(flag);
    if (!role) return null;
    if (payloadFree && ['field', 'header'].includes(role)) return null;
    const value = attached ? token.slice(2) : equals < 0 ? tokens[++index] : token.slice(equals + 1);
    if (value === undefined) return null;
    if (role === 'method') method = value.toUpperCase();
    if (role === 'field') fields = true;
  }
  if (!endpoint || endpoint === 'graphql' || !['GET', 'HEAD'].includes(method ?? (fields ? 'POST' : 'GET')))
    return null;
  return { effect: 'read', target: `github://api/${endpoint}` };
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
