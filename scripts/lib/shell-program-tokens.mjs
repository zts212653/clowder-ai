import { resolve } from 'node:path';
import { commandName, tokenizeSimpleShellCommand } from '../native-effect-shell-tokenizer.mjs';
import { SUBSTITUTION } from './shell-text.mjs';
import { afterWrapper, WRAPPERS } from './shell-wrappers.mjs';

const MAX_RECURSION = 8;

/** Shell grammar, not programs. `then pnpm runtime:stop` runs pnpm. */
const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'in',
  'case',
  'esac',
  'select',
  'function',
  'coproc',
  '{',
  '}',
  '(',
  ')',
  '!',
]);

/** Shell grammar and variable assignments; neither is the program. */
function skipNoise(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && !SHELL_KEYWORDS.has(token)) break;
    index += 1;
  }
  return tokens.slice(index);
}

/**
 * A coordinate change resolves against the coordinate in force when it happens.
 *
 * Carrying the raw string and resolving it later means resolving it against
 * whoever looks at it -- which for a relative `-C` was this process's own cwd.
 * And two changes compose: `env -C /a env -C b` runs in `/a/b`, not `b`.
 */
export function moveCoordinate(value, base) {
  if (value.startsWith('/')) return resolve(value);
  return base ? resolve(base, value) : undefined;
}

/**
 * Strip keyword, assignment and wrapper noise; hand back what actually runs,
 * plus anything the wrapper changed about how it runs.
 *
 * The loop matters twice over: `env FOO=1 kill ...` puts assignments *after*
 * the wrapper, and a wrapper can hand off to another wrapper.
 */
export function programTokens(tokens, outerCwd, inquiryContext = false) {
  let rest = tokens;
  let cwd = outerCwd;
  const directoryOperands = [];
  const environment = [];
  const wrappers = [];
  let coordinateKnown = true;
  let builtinContext = inquiryContext;
  const finish = (rest, complete, lookupOnly = false) => ({
    rest,
    complete,
    cwd,
    directoryOperands,
    environment,
    wrappers,
    coordinateKnown,
    lookupOnly,
  });
  for (let guard = 0; guard <= MAX_RECURSION; guard++) {
    const clean = skipNoise(rest);
    environment.push(...rest.slice(0, rest.length - clean.length).filter((word) => /^[A-Za-z_]\w*=/.test(word)));
    coordinateKnown &&= !rest
      .slice(0, rest.length - clean.length)
      .some((word) => /^GIT_(?:DIR|WORK_TREE|COMMON_DIR)=/.test(word));
    rest = clean;
    if (rest.length === 0) {
      const leaf = wrappers.at(-1);
      return finish(leaf ? [leaf.program, ...leaf.options] : [], true);
    }
    // A shell builtin inquiry reads program names; it never delegates to them.
    // After an external launcher (env/exec/sudo/...), `command` is no longer
    // proven to be the shell builtin. A basename match cannot grant this role.
    const spec = WRAPPERS.get(commandName(rest[0]) ?? '');
    if (!spec) return finish(rest, true);
    const consumed = afterWrapper(spec, rest.slice(1));
    if (builtinContext && !environment.length && rest[0] === 'command' && consumed.complete && consumed.inquiry)
      return finish(rest, true, true);
    builtinContext &&= ['command', 'builtin'].includes(rest[0]);
    wrappers.push({
      program: rest[0],
      cwd,
      environment: [...environment],
      options: rest.slice(1, rest.length - consumed.rest.length),
      ...(consumed.inquiry ? { inquiry: true } : {}),
    });
    if (consumed.cwd !== undefined) directoryOperands.push(consumed.cwd);
    if (spec.stdinCommands && consumed.complete && consumed.rest.length === 0) return finish([rest[0]], true);
    if (consumed.commandString !== undefined)
      return { ...finish([rest[0]], consumed.complete), script: consumed.commandString };
    if (!consumed.complete) return finish([], false);
    if (consumed.cwd !== undefined) {
      const moved = moveCoordinate(consumed.cwd, cwd);
      if (moved === undefined) return finish([], false);
      cwd = moved;
    }
    if (consumed.splitString !== undefined) {
      // `-S` splits a string into argv words. It is not a shell: a `;` in there
      // is an argument, not a separator, and nothing after it is a command.
      const words = tokenizeSimpleShellCommand(consumed.splitString);
      if (!words) return finish([], false);
      rest = [...words, ...consumed.rest];
      continue;
    }
    rest = consumed.rest;
  }
  return finish([], false);
}

/** Nothing here can be read as a name: an expansion, or a substitution's output. */
export function unreadableProgram(token) {
  return token.includes(SUBSTITUTION) || /\$\w|\$\{/.test(token);
}

/** Preserve raw directory operands; cwd is an observation, not physical path proof. */
export function annotateCoordinate(result, program, argvComplete) {
  if (result.invocation)
    Object.assign(result.invocation, {
      directoryOperands: program.directoryOperands,
      environment: program.environment,
      wrappers: program.wrappers,
      program: program.rest[0],
      programOperands: program.rest.slice(1),
      coordinateKnown: program.coordinateKnown,
      argvComplete,
      lookupOnly: program.lookupOnly,
    });
  return result;
}

/** Leading group/negation grammar does not hide the control word it precedes. */
export function leadingShellControl(raw) {
  const text = raw.replace(/^(?:\s*[{}!])*\s*/, '');
  return text.match(/^(if|then|else|elif|for|while|until|case|function)\b/)?.[1];
}

/** The caller's native namespace is not known after shell startup imports. */
export function nativeBuiltinContext(known, env = process.env) {
  return Boolean(known && !env.BASH_ENV && !env.ENV && !Object.keys(env).some((name) => name.startsWith('BASH_FUNC_')));
}

/** External argv launchers select executable children, never parent-shell builtins. */
export function delegatedProgramTokens(tokens, cwd, parent) {
  const child = programTokens(tokens, cwd, false);
  child.environment = [...parent.environment, ...child.environment];
  child.wrappers = [
    ...parent.wrappers,
    {
      program: parent.rest[0],
      cwd: parent.cwd,
      environment: parent.environment,
      options: [],
    },
    ...child.wrappers,
  ];
  return child;
}
