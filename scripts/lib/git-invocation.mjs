/** Parse Git's global argv once, retaining directory changes before the subcommand. */
export function gitInvocationArguments(operands) {
  const directories = [];
  let coordinateKnown = true;
  let index = 0;
  while (index < operands.length && operands[index].startsWith('-')) {
    const option = globalOption(operands, index);
    if (!option || option.missing) return { args: null, directories, coordinateKnown: false };
    if (option.directory !== undefined) directories.push(option.directory);
    coordinateKnown &&= option.coordinateKnown;
    index = option.next;
  }
  return { args: operands.slice(index), directories, coordinateKnown };
}

function globalOption(operands, index) {
  const token = operands[index];
  const short = token.slice(0, 2);
  if (['-C', '-c'].includes(short)) {
    const separate = token.length === 2;
    const value = separate ? operands[index + 1] : token.slice(2);
    return {
      next: index + (separate ? 2 : 1),
      missing: value === undefined,
      directory: short === '-C' ? value : undefined,
      coordinateKnown: short === '-C' || !changesWorktreeConfig(value),
    };
  }
  const name = token.split('=', 1)[0];
  if (SELECTORS.has(name)) return { next: index + (token.includes('=') ? 1 : 2), coordinateKnown: false };
  if (token === '--bare' || (name === '--exec-path' && token.includes('=')))
    return { next: index + 1, coordinateKnown: false };
  return CONTEXT_FREE_FLAGS.has(token) ? { next: index + 1, coordinateKnown: true } : null;
}

const SELECTORS = new Set(['--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source']);
const CONTEXT_FREE_FLAGS = new Set([
  '-p',
  '-P',
  '--paginate',
  '--no-pager',
  '--no-optional-locks',
  '--no-lazy-fetch',
  '--no-advice',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
]);

function changesWorktreeConfig(value) {
  return /^(?:core\.(?:worktree|bare)|include(?:if\.[^=]+)?\.path)(?:=|$)/i.test(value);
}

/** Existing effect consumers need the same subcommand grammar, without target attribution. */
export function gitSubcommandArgs(operands) {
  return operands ? gitInvocationArguments(operands).args : null;
}

/** Git remove accepts repeated force flags, an optional terminator, and one path. */
export function worktreeRemovalOperand(args) {
  if (args?.[0] !== 'worktree' || args[1] !== 'remove') return null;
  let options = true;
  let target = null;
  for (const token of args.slice(2)) {
    if (options && token === '--') {
      options = false;
      continue;
    }
    if (options && (token === '--force' || /^-f+$/.test(token))) continue;
    if ((options && token.startsWith('-')) || target !== null || token.length === 0) return null;
    target = token;
  }
  return target;
}

export function isWorktreeRemoval(args) {
  return args?.[0] === 'worktree' && args[1] === 'remove';
}

export function isTemporaryWorktreePath(raw) {
  return /^\/(?:private\/)?tmp\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw);
}
