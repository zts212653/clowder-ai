/**
 * F300 -- the option metadata of programs that run other programs.
 *
 * `sudo -u root kill -TERM 4242` runs `kill`, not `root`. Reading it any other
 * way requires knowing which of a wrapper's options take a value, so this is a
 * table of exactly that, and an option missing from the table makes the parse
 * incomplete rather than being skipped. Skipping is how the value came to be
 * mistaken for the program in the first place.
 */

export const WRAPPERS = new Map([
  [
    'sudo',
    {
      flags: new Set(['-E', '-H', '-n', '-b', '-i', '-s', '-k', '-A', '-P', '-S', '--']),
      // `-C` is close-from, not chdir; sudo's chdir is `-D`/`--chdir`.
      valued: new Set(['-u', '-g', '-p', '-C', '-r', '-t', '-h', '-D', '--user', '--group', '--chdir']),
      cwdOptions: new Set(['-D', '--chdir']),
    },
  ],
  [
    'env',
    {
      flags: new Set(['-i', '-0', '--ignore-environment', '--null', '--']),
      valued: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
      cwdOptions: new Set(['-C', '--chdir']),
      /** `env -S "<command>"` splits the string and executes it. */
      scriptOptions: new Set(['-S', '--split-string']),
    },
  ],
  ['nice', { flags: new Set(['--']), valued: new Set(['-n', '--adjustment']) }],
  ['nohup', { flags: new Set(['--']), valued: new Set() }],
  ['time', { flags: new Set(['-p', '-a', '--']), valued: new Set(['-o', '-f', '--output', '--format']) }],
  ['command', { flags: new Set(['-p', '-v', '-V', '--']), valued: new Set() }],
  ['exec', { flags: new Set(['-c', '-l', '--']), valued: new Set(['-a']) }],
  ['builtin', { flags: new Set(['--']), valued: new Set() }],
  ['setsid', { flags: new Set(['-f', '-w', '--fork', '--wait', '--']), valued: new Set() }],
  ['caffeinate', { flags: new Set(['-d', '-i', '-m', '-s', '-u', '--']), valued: new Set(['-t', '-w']) }],
  [
    'stdbuf',
    {
      flags: new Set(['--help', '--version']),
      valued: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
      attachedValues: new Set(['-i', '-o', '-e']),
    },
  ],
  ['unbuffer', { flags: new Set(['-p']), valued: new Set() }],
  ['arch', { flags: new Set(['-i386', '-x86_64', '-arm64', '-arm64e']), valued: new Set(['-arch']) }],
  [
    'ionice',
    {
      flags: new Set(['-t', '--ignore', '-h', '--help', '-V', '--version']),
      // PID/PGID/UID modes consume lists, not a child command; leave them unproved.
      valued: new Set(['-c', '-n', '--class', '--classdata']),
      attachedValues: new Set(['-c', '-n']),
    },
  ],
  ['corepack', { flags: new Set(['--']), valued: new Set() }],
  ['chronic', { flags: new Set(['--']), valued: new Set() }],
  ['doas', { flags: new Set(['-n', '-C', '-L', '-s', '--']), valued: new Set(['-u']) }],
  [
    'npx',
    {
      flags: new Set(['-y', '--yes', '--no', '--']),
      valued: new Set(['-p', '--package', '-c', '--call']),
      commandStringOptions: new Set(['-c', '--call']),
    },
  ],
  ['parallel', { flags: new Set(['--']), valued: new Set(['-j', '--jobs']), stdinCommands: true }],
  ['ssh', { flags: new Set(['--']), valued: new Set(['-p', '-i', '-l', '-o']), leadingOperands: 1 }],
  [
    'script',
    {
      flags: new Set(['-q', '-a', '-f', '--']),
      valued: new Set(['-c', '--command']),
      commandStringOptions: new Set(['-c', '--command']),
      leadingOperands: 1,
      commandStringTailOperands: 1,
    },
  ],
  [
    'timeout',
    {
      flags: new Set(['--preserve-status', '--foreground', '-f', '--']),
      valued: new Set(['-s', '-k', '--signal', '--kill-after']),
      /** The duration is a positional operand that comes before the command. */
      leadingOperands: 1,
    },
  ],
  [
    'gtimeout',
    {
      flags: new Set(['--preserve-status', '--foreground', '-f', '--']),
      valued: new Set(['-s', '-k', '--signal', '--kill-after']),
      leadingOperands: 1,
    },
  ],
  ['screen', { flags: new Set(['-d', '-m', '-dm', '--']), valued: new Set(['-S', '-t']) }],
]);

/** xargs keeps its outer stdin role; the shared reader also inspects this child argv. */
export const XARGS_WRAPPER = {
  flags: new Set(['-0', '-r', '-t', '-p', '-x', '--null', '--no-run-if-empty', '--verbose', '--interactive', '--']),
  valued: new Set([
    '-I',
    '-n',
    '-L',
    '-P',
    '-s',
    '-E',
    '--replace',
    '--max-args',
    '--max-lines',
    '--max-procs',
    '--max-chars',
    '--eof',
  ]),
  attachedValues: new Set(['-I', '-n', '-L', '-P', '-s', '-E']),
  replacementOptions: new Set(['-I', '--replace']),
};

/**
 * Consume a wrapper's own arguments, and hand back what it would run.
 *
 * Two of those arguments are not noise and must not be dropped: an option that
 * moves the execution coordinate (`env -C dir`) changes where the command's own
 * relative paths land, and an option that *is* a command (`env -S "..."`) is
 * executed content. Losing either while reporting a complete parse is how a
 * delete inside our own checkout came back allowed.
 *
 * @returns {{rest: string[], complete: boolean, cwd?: string, splitString?: string, replacement?: string}}
 * `complete: false` when an option was not in the table -- it could take a
 * value, or change what runs.
 */
export function afterWrapper(spec, operands) {
  let index = 0;
  let leading = spec.leadingOperands ?? 0;
  let cwd;
  let replacement;
  while (index < operands.length) {
    const token = operands[index];
    if (!token.startsWith('-')) {
      if (leading === 0)
        return {
          rest: operands.slice(index),
          complete: true,
          cwd,
          ...(replacement === undefined ? {} : { replacement }),
        };
      leading -= 1;
      index += 1;
      continue;
    }
    if (token === '--')
      return {
        rest: operands.slice(index + 1),
        complete: true,
        cwd,
        ...(replacement === undefined ? {} : { replacement }),
      };
    const inline = token.includes('=');
    const attached = token.length > 2 && spec.attachedValues?.has(token.slice(0, 2));
    const named = inline ? token.slice(0, token.indexOf('=')) : attached ? token.slice(0, 2) : token;
    if (spec.valued.has(named)) {
      const value = inline ? token.slice(named.length + 1) : attached ? token.slice(2) : operands[index + 1];
      const next = index + (inline || attached ? 1 : 2);
      if (value === undefined) return { rest: [], complete: false };
      if (spec.replacementOptions?.has(named)) replacement = value;
      if (spec.commandStringOptions?.has(named)) {
        const rest = operands.slice(next);
        return {
          rest,
          commandString: value ?? '',
          cwd,
          complete: value !== undefined && rest.length <= (spec.commandStringTailOperands ?? 0),
        };
      }
      // `env -S "<words>"` splits the string into argv and then *appends the
      // rest of its own argv*: `env -S "kill -TERM 9999" 4242` signals 4242 too.
      // Returning at the option and dropping the tail loses a real target.
      if (spec.scriptOptions?.has(named)) {
        return { rest: operands.slice(next), complete: true, cwd, splitString: value ?? '' };
      }
      if (spec.cwdOptions?.has(named)) cwd = value;
      index = next;
      continue;
    }
    if (spec.flags.has(named)) {
      index += 1;
      continue;
    }
    return { rest: [], complete: false };
  }
  return { rest: [], complete: true, cwd, ...(replacement === undefined ? {} : { replacement }) };
}
