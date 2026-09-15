import { resolve } from 'node:path';

import { commandName, tokenizeSimpleShellCommand } from '../native-effect-shell-tokenizer.mjs';
import { extractSubstitutions, SUBSTITUTION, splitCommandLines, splitPipelineStages, unquote } from './shell-text.mjs';
import { afterWrapper, WRAPPERS } from './shell-wrappers.mjs';

/**
 * F300 -- reading a command line as argv rather than as prose.
 *
 * Two mistakes produced this module, and they are the same mistake twice.
 *
 * First, matching a dangerous word wherever it appears: `rg "runtime:stop"` and
 * `echo pnpm runtime:stop` contain the word and run nothing. A guard that
 * cannot tell them apart blocks the only way to inspect what it guards.
 *
 * Then, reading only the first token of a line: `bash -c 'kill -TERM 4242'`,
 * `printf x | pnpm runtime:stop`, `if true; then pnpm runtime:stop; fi`,
 * `echo $(pnpm runtime:stop)` and `sudo -u root kill -TERM 4242` all run
 * something the first token is not. Skipping a wrapper's option *value* as if it
 * were a flag is the same error wearing a different hat.
 *
 * So there is one answer to "what would this actually run", with a completeness
 * result attached, and every consumer reads that same answer. Executed content
 * is executed wherever it sits: behind a wrapper, inside a shell string, in a
 * later pipeline stage, inside a command substitution. What we could not read
 * comes back `complete: false` -- unreadable is not the same as harmless.
 */

export { splitCommandLines, unquote };

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
  '{',
  '}',
  '(',
  ')',
  '!',
]);

/** Shells whose `-c` operand is a script we have to read. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/** The value of `--opt value` or `--opt=value`, whichever form was used. */
export function optionValue(tokens, option) {
  const index = tokens.indexOf(option);
  if (index >= 0) return tokens[index + 1];
  const inline = tokens.find((token) => token.startsWith(`${option}=`));
  return inline?.slice(option.length + 1);
}

/**
 * Everything a command line would actually run.
 *
 * @returns {{pipelines: {name: string|undefined, operands: string[], text: string}[][],
 *   complete: boolean}} pipelines in stage order (adjacency matters: only the
 *   stage feeding a killer directly can describe its stdin), and whether every
 *   construct that executes something was read to a conclusion.
 */
export function executedInvocations(raw, { depth = 0, cwd } = {}) {
  if (depth > MAX_RECURSION) return { pipelines: [], complete: false };

  const pipelines = [];
  let complete = true;

  for (const line of splitCommandLines(String(raw ?? ''))) {
    const pipeline = [];
    for (const stage of splitPipelineStages(line)) {
      const parsed = parseStage(stage, depth, cwd);
      if (!parsed.complete) complete = false;
      // Every stage keeps its place, even one whose insides we read separately.
      // Dropping it would hand the next stage a stdin that never came from here.
      if (parsed.invocation) pipeline.push(parsed.invocation);
      pipelines.push(...parsed.nested);
    }
    if (pipeline.length > 0) pipelines.push(pipeline);
  }

  return { pipelines, complete };
}

function nestedFrom(source, depth, cwd) {
  const result = executedInvocations(source, { depth: depth + 1, cwd });
  return { nested: result.pipelines, complete: result.complete };
}

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
function moveCoordinate(value, base) {
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
function programTokens(tokens, outerCwd) {
  let rest = tokens;
  let cwd = outerCwd;
  for (let guard = 0; guard <= MAX_RECURSION; guard++) {
    rest = skipNoise(rest);
    if (rest.length === 0) return { rest: [], complete: true, cwd };
    const spec = WRAPPERS.get(commandName(rest[0]) ?? '');
    if (!spec) return { rest, complete: true, cwd };
    const consumed = afterWrapper(spec, rest.slice(1));
    if (!consumed.complete) return { rest: [], complete: false, cwd };
    if (consumed.cwd !== undefined) {
      const moved = moveCoordinate(consumed.cwd, cwd);
      if (moved === undefined) return { rest: [], complete: false, cwd };
      cwd = moved;
    }
    if (consumed.splitString !== undefined) {
      // `-S` splits a string into argv words. It is not a shell: a `;` in there
      // is an argument, not a separator, and nothing after it is a command.
      const words = tokenizeSimpleShellCommand(consumed.splitString);
      if (!words) return { rest: [], complete: false, cwd };
      rest = [...words, ...consumed.rest];
      continue;
    }
    rest = consumed.rest;
  }
  return { rest: [], complete: false, cwd };
}

/** Nothing here can be read as a name: an expansion, or a substitution's output. */
function unreadableProgram(token) {
  return token === SUBSTITUTION || /\$\w|\$\{/.test(token);
}

/** The script an interpreter was told to run inline, if it was told inline. */
function inlineScriptOf(name, operands) {
  if (name === 'eval') return operands.length > 0 ? operands.join(' ') : '';
  if (!SHELLS.has(name ?? '')) return undefined;
  const flagIndex = operands.findIndex((token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
  return flagIndex >= 0 ? (operands[flagIndex + 1] ?? '') : undefined;
}

function invocation(name, operands, stage, cwd) {
  return { name, operands, text: stage, cwd };
}

/** An interpreter given a script *file* runs that file, so the file is the program. */
function scriptFileInvocation(operands, stage, cwd) {
  const fileIndex = operands.findIndex((token) => !token.startsWith('-'));
  if (fileIndex < 0) return undefined;
  return invocation(commandName(operands[fileIndex]), operands.slice(fileIndex + 1), stage, cwd);
}

/**
 * A stage that runs a script string: read the script, and keep the stage.
 *
 * The stage still occupies its slot in the pipeline. It does not describe what
 * it writes to the next stage, so anything downstream that reads stdin can no
 * longer point past it -- which is the whole reason it must not vanish.
 */
function inlineExecution({ script, name, stage, depth, cwd, nested, complete }) {
  const stageInvocation = invocation(name, [], stage, cwd);
  if (!script || unreadableProgram(script)) {
    return { invocation: stageInvocation, nested, complete: false };
  }
  const result = nestedFrom(unquote(script) ?? '', depth, cwd);
  return {
    invocation: stageInvocation,
    nested: [...nested, ...result.nested],
    complete: complete && result.complete,
  };
}

function parseStage(stage, depth, outerCwd) {
  const substitutions = extractSubstitutions(stage);
  const nested = [];
  let complete = substitutions.readable;
  for (const inner of substitutions.inner) {
    const result = nestedFrom(inner, depth, outerCwd);
    nested.push(...result.nested);
    if (!result.complete) complete = false;
  }
  const unreadable = { invocation: undefined, nested, complete: false };

  const tokens = tokenizeSimpleShellCommand(substitutions.text);
  if (!tokens || tokens.length === 0) return unreadable;

  // A wrapper that moved the coordinate moved it for everything it runs.
  const program = programTokens(tokens, outerCwd);
  if (!program.complete) return unreadable;
  const cwd = program.cwd;

  const rest = program.rest;
  if (rest.length === 0) return { invocation: undefined, nested, complete };
  if (unreadableProgram(rest[0])) return unreadable;

  const name = commandName(rest[0]);
  const operands = rest.slice(1);

  // `bash -c "<script>"` and `eval "<script>"` run the string they were handed.
  const inlineScript = inlineScriptOf(name, operands);
  if (inlineScript !== undefined) {
    return inlineExecution({ script: inlineScript, name, stage, depth, cwd, nested, complete });
  }

  if (SHELLS.has(name ?? '')) return { invocation: scriptFileInvocation(operands, stage, cwd), nested, complete };

  if (name === 'node') {
    // `node -e '<js>'` executes code this module does not model.
    if (operands.some((token) => ['-e', '--eval', '-p', '--print'].includes(token))) return unreadable;
    const invocation = scriptFileInvocation(operands, stage, cwd);
    if (invocation) return { invocation, nested, complete };
  }

  return { invocation: invocation(name, operands, stage, cwd), nested, complete };
}
