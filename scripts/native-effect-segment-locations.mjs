import { homedir } from 'node:os';
import { cdReadings, kernelPath } from './lib/shell-directory.mjs';
import { expandAll, FORGOTTEN, isShellBinding, OPAQUE } from './native-effect-shell-expansion.mjs';
import { shellWords, tokenizeSimpleShellCommand } from './native-effect-shell-tokenizer.mjs';

/**
 * Where can each segment of a command line run?
 *
 * A segment's working directory is part of its target (`git reset --hard` rewrites the
 * checkout it runs in). Before 2026-09-27 nothing tracked it; the guard re-paired the
 * strongest effect with any protected word in the text instead. This follows the shell's
 * execution paths instead of approximating them (codex-astra review of #4817):
 *
 * - Each path carries (directory, assignment bindings, last status, subshell frames).
 * - `&&` runs a segment only on paths whose last status is success, `||` only on failure;
 *   `;`, newline, `&` and `|` run it on every path. A path that skips a segment which
 *   opens a group (`(`, `{`, `if`, `for`, `while`) skips the whole group.
 * - `cd`/`pushd` fork a path into success (new directory; both logical and physical
 *   readings, see lib/shell-directory.mjs) and failure (unchanged). Other commands fork
 *   into success and failure without moving; `true`/`:` succeed and `false` fails.
 * - Every `(` in a segment (subshell, `$(`) opens a frame before its command and every
 *   `)` closes one after it: the directory and bindings in force before the frame come
 *   back, so `(cd X && pwd); pwd` ends where it started. `&`/`|` stages are subshells too.
 * - A command after `then`/`else`/`elif`/`do` may or may not run (branches and loops
 *   are not evaluated), so both outcomes are kept.
 * - Assignment statements bind on the path that runs them (`false && X=1` binds
 *   nothing); `VAR=x cmd` binds for that command only; `for NAME in words` binds each
 *   word. `~`, `$HOME` and the environment fill the rest.
 * - What cannot be read -- a `cd` operand with an unknown variable or a substitution,
 *   `popd`, unbalanced grouping -- moves the path to an unknown directory: the guard
 *   judges such a segment without a working directory rather than invent one.
 *
 * @param {{text: string, separator: string|null}[]} segments
 * @param {string|undefined} cwd
 * @returns {(string|undefined)[][]} possible directories per segment (undefined = unknown)
 */
export function segmentLocations(segments, cwd, env = process.env) {
  return judgedPaths(segments, cwd, env).map((judged) =>
    unique(judged.flatMap((path) => directoriesOf(path.location))),
  );
}

/**
 * The same walk, keeping what each directory reading was reached with: per segment, every
 * `{ directory, bindings }` it can run in (slice 2b -- a variable a command bound earlier is
 * an operand's value, read with `expandWordValues`). `bindings` is the path's own map; a
 * forgotten map (too many paths) makes every variable unreadable.
 */
export function segmentContexts(segments, cwd, env = process.env) {
  return judgedPaths(segments, cwd, env).map((judged) => {
    const seen = new Map();
    for (const path of judged) {
      for (const directory of directoriesOf(path.location)) {
        const key = JSON.stringify([directory ?? null, [...path.bindings]]);
        if (!seen.has(key)) seen.set(key, { directory, bindings: path.bindings });
      }
    }
    return [...seen.values()];
  });
}

function judgedPaths(segments, cwd, env) {
  const start = cwd === undefined ? UNKNOWN : { logical: cwd, physical: kernelPath(cwd) ?? cwd };
  let paths = [{ location: start, bindings: new Map(), status: 'ok', frames: [], skipped: [] }];
  return segments.map((segment, index) => {
    const shape = segmentShape(segment.text);
    const inSubshell = segment.separator === '|' || ['|', '&'].includes(segments[index + 1]?.separator);
    const next = [];
    const running = [];
    for (const path of paths) {
      if (path.skipped.length > 0 || !gateAdmits(segment.separator, path.status)) {
        next.push(skipSegment(path, shape));
        continue;
      }
      running.push(path);
      next.push(...runSegment(path, shape, inSubshell, env));
    }
    const judged = running.length > 0 ? running : paths;
    paths = dedupe(next);
    return judged;
  });
}

/**
 * The command a segment runs, without the grouping around it: `(cd X` runs `cd X`,
 * `then git reset --hard` runs `git reset --hard`, `pwd)` runs `pwd`. Effects are judged
 * on this text; the grouping itself is already accounted for by the locations above.
 */
/** A segment that is only shell structure (`fi`, `done`, `}`) runs nothing of its own. */
export function isShellStructure(text) {
  return /^\s*(?:fi|done|esac|then|do|else|;;)?\s*$/.test(segmentCommandText(text));
}

export function segmentCommandText(text) {
  // `{` and `}` group only as words of their own; `{e,x}` is brace expansion, not grouping.
  let command = text.replace(/^\s*(?:\(\s*|\$\(\s*|\{\s+|(?:then|do|else|elif|if|while|until|!)\s+)*/, '').trimEnd();
  const unmatched = () => (command.match(/\)/g)?.length ?? 0) - (command.match(/\(/g)?.length ?? 0);
  for (;;) {
    if (command === '}' || /\s\}$/.test(command)) command = command.slice(0, -1).trimEnd();
    else if (command.endsWith(')') && unmatched() > 0) command = command.slice(0, -1).trimEnd();
    else return command;
  }
}

const UNKNOWN = null;
const MAX_PATHS = 64;
const MAY_NOT_RUN = new Set(['then', 'else', 'elif', 'do']);
const TRANSPARENT = new Set(['if', 'while', 'until', '!', '{', 'time']);
const GROUP_OPENERS = new Set(['{', 'if', 'for', 'while', 'until', 'case', 'select']);
const GROUP_CLOSERS = new Set(['}', 'fi', 'done', 'esac']);

function gateAdmits(separator, status) {
  if (separator === '&&') return status === 'ok';
  if (separator === '||') return status === 'fail';
  return true;
}

/**
 * The segment's grouping, read so it holds even when its words hold a substitution:
 * parentheses outside quotes (subshells, `$(`), and every leading opener / trailing closer
 * word (`{ {` is two groups). A substitution is masked to one opaque word.
 */
function segmentShape(text) {
  const unquoted = text.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
  const pushes = unquoted.split('(').length - 1;
  const pops = unquoted.split(')').length - 1;
  const masked = text.replace(/\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`/g, OPAQUE);
  // Assignment words join adjacent quoted pieces: B='a b' is one binding, not B= plus an argv.
  const tokens = isShellBinding(masked)
    ? shellWords(masked).map(({ value }) => value)
    : tokenizeSimpleShellCommand(masked);
  const words = (tokens ?? masked.trim().split(/\s+/)).filter(Boolean);
  const openers = leadingOpeners(words);
  const closers = trailingClosers(words);
  // Parentheses inside the command (a substitution that spans segments) open before it
  // runs and close after it, like the leading and trailing ones.
  const innerPushes = Math.max(0, pushes - openers.filter((type) => type === '(').length);
  const innerPops = Math.max(0, pops - closers.filter((type) => type === ')').length);
  return {
    tokens,
    pushes,
    pops,
    openers: [...openers, ...Array(innerPushes).fill('(')],
    closers: [...Array(innerPops).fill(')'), ...closers],
  };
}

/** `(`, `{`, `if`, `for`, `while` … in front of the command, in order; `then`/`do`/`!` pass. */
function leadingOpeners(words) {
  const openers = [];
  for (const word of words) {
    const [, parens, core] = word.match(/^(\(*)(.*)$/s);
    openers.push(...Array(parens.length).fill('('));
    if (core === '' || MAY_NOT_RUN.has(core) || core === '!') continue;
    if (!GROUP_OPENERS.has(core)) break;
    openers.push('kw');
  }
  return openers;
}

/** `)`, `}`, `fi`, `done` … after the command, in the order they close. */
function trailingClosers(words) {
  const closers = [];
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const [, core, parens] = words[i].match(/^(.*?)(\)*)$/s);
    const closing = Array(parens.length).fill(')');
    if (core === '') {
      closers.unshift(...closing);
    } else if (GROUP_CLOSERS.has(core)) {
      closers.unshift('kw', ...closing);
    } else {
      closers.unshift(...closing);
      break;
    }
  }
  return closers;
}

/**
 * A path that does not run this segment still meets its grouping: groups opening here are
 * skipped whole, and a closer that ends a group the path is already inside still ends it
 * (`(cd X && false && pwd); pwd` leaves the subshell although `pwd)` never runs).
 */
function skipSegment(path, shape) {
  const skipped = [...path.skipped, ...shape.openers];
  let current = path;
  for (const type of shape.closers) {
    if (skipped.length > 0) skipped.pop();
    else if (type === ')') current = closeFrames(current, 1);
  }
  return { ...current, skipped };
}

function runSegment(path, shape, inSubshell, env) {
  const frames = [...path.frames];
  const subshells = shape.openers.filter((type) => type === '(').length;
  for (let i = 0; i < subshells; i += 1) frames.push({ location: path.location, bindings: path.bindings });
  const entry = { ...path, frames };
  const outcomes = [];
  const command = shape.tokens ? peel(shape.tokens) : { words: [OPAQUE], mayNotRun: false, negated: false };
  if (command.mayNotRun) outcomes.push(entry);
  for (const outcome of execute(entry, command.words, env)) {
    const status = command.negated ? (outcome.status === 'ok' ? 'fail' : 'ok') : outcome.status;
    // An explicit subshell group restores its state at the closing parenthesis,
    // not after its first command when the group happens to follow a pipe.
    const kept = inSubshell && subshells === 0 ? { location: entry.location, bindings: entry.bindings } : {};
    outcomes.push({ ...outcome, ...kept, status });
  }
  const exits = shape.closers.filter((type) => type === ')').length;
  return outcomes.map((outcome) => closeFrames(outcome, exits));
}

function peel(tokens) {
  const words = [...tokens];
  let mayNotRun = false;
  let negated = false;
  while (words.length > 0) {
    const bare = words[0].replace(/^\(+/, '');
    if (bare === '') {
      words.shift();
    } else if (MAY_NOT_RUN.has(bare) || TRANSPARENT.has(bare)) {
      if (MAY_NOT_RUN.has(bare)) mayNotRun = true;
      if (bare === '!') negated = !negated;
      words.shift();
    } else {
      words[0] = bare;
      break;
    }
  }
  const bare = words.map((word) => word.replace(/\)+$/, '')).filter((word) => word && word !== '}');
  return { words: bare, mayNotRun, negated };
}

function execute(path, words, env) {
  const [program, ...operands] = words;
  if (program === undefined || program === 'fi' || program === 'done' || program === 'esac' || program === '}') {
    return [path];
  }
  if (program === 'for' && operands[1] === 'in') return [bindFor(path, operands, env)];
  if (words.every((word) => /^[A-Za-z_]\w*=/.test(word)) || program === 'export') return [assign(path, words, env)];
  if (program === 'cd' || program === 'pushd') return changeDirectory(path, operands, env);
  if (program === 'popd')
    return [
      { ...path, location: UNKNOWN, status: 'ok' },
      { ...path, status: 'fail' },
    ];
  // Only these have a fixed status; everything else (printf, pwd, echo included) can fail.
  if (program === 'true' || program === ':') return [{ ...path, status: 'ok' }];
  if (program === 'false') return [{ ...path, status: 'fail' }];
  return [
    { ...path, status: 'ok' },
    { ...path, status: 'fail' },
  ];
}

function changeDirectory(path, operands, env) {
  const physicalOnly = operands.includes('-P');
  const rest = operands.filter((word) => !['-P', '-L', '--'].includes(word));
  const failed = { ...path, status: 'fail' };
  if (rest.length > 1 || rest[0] === '-') return [{ ...path, location: UNKNOWN, status: 'ok' }, failed];
  const values = rest.length === 0 ? [homedir()] : expandAll(rest[0], path.bindings, env);
  const relativeFromUnknown = path.location === UNKNOWN && values?.some((value) => !value.startsWith('/'));
  if (!values || relativeFromUnknown) return [{ ...path, location: UNKNOWN, status: 'ok' }, failed];
  const base = path.location ?? { logical: '/', physical: '/' };
  const moved = values.flatMap((value) => cdReadings(base, value, { physicalOnly }));
  return [...moved.map((location) => ({ ...path, location, status: 'ok' })), failed];
}

function assign(path, words, env) {
  const bindings = new Map(path.bindings);
  for (const word of words[0] === 'export' ? words.slice(1) : words) {
    const index = word.indexOf('=');
    if (index < 0) continue;
    const values = expandAll(word.slice(index + 1), path.bindings, env);
    if (values && values.length === 1) bindings.set(word.slice(0, index), values);
    else bindings.set(word.slice(0, index), null);
  }
  return { ...path, bindings, status: 'ok' };
}

function bindFor(path, operands, env) {
  const bindings = new Map(path.bindings);
  const values = operands.slice(2).map((word) => expandAll(word, path.bindings, env));
  bindings.set(operands[0], values.every((value) => value?.length === 1) ? values.flat() : null);
  return { ...path, bindings, status: 'ok' };
}

function closeFrames(path, pops) {
  const frames = [...path.frames];
  let { location, bindings } = path;
  for (let i = 0; i < pops; i += 1) {
    const frame = frames.pop();
    if (!frame) return { ...path, location: UNKNOWN, frames: [] };
    ({ location, bindings } = frame);
  }
  return { ...path, location, bindings, frames };
}

function directoriesOf(location) {
  return location === UNKNOWN ? [undefined] : unique([location.logical, location.physical]);
}

function dedupe(paths) {
  const seen = new Map();
  for (const path of paths) {
    const key = JSON.stringify([
      path.location,
      [...path.bindings],
      path.status,
      path.skipped,
      path.frames.map((frame) => [frame.location, [...frame.bindings]]),
    ]);
    if (!seen.has(key)) seen.set(key, path);
  }
  const distinct = [...seen.values()];
  if (distinct.length <= MAX_PATHS) return distinct;
  // Too many paths to follow exactly: keep every directory and both statuses, forget the
  // bindings (later expansions then read as unknown) rather than drop a directory.
  const merged = new Map();
  for (const path of distinct) {
    for (const status of ['ok', 'fail']) {
      const key = JSON.stringify([path.location, status, path.skipped, path.frames.length]);
      if (!merged.has(key)) merged.set(key, { ...path, status, bindings: new Map([[FORGOTTEN, null]]) });
    }
  }
  return [...merged.values()];
}

function unique(values) {
  return [...new Set(values)];
}
