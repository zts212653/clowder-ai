import { matchesGlob } from 'node:path';
import { commandName, stableArgumentWord } from './native-effect-shell-tokenizer.mjs';

/**
 * `find`'s own grammar, read as argv.
 *
 * find is the one delete-capable program whose effect lives entirely in its
 * arguments, and its grammar decides what each word is. Scanning for the word
 * `-delete` gets three things wrong at once: it fires on a `-name '-delete'`
 * pattern, it credits the first `-exec` for what a later one does, and it reads
 * the arguments an `-exec` hands to its own program as if they were find's.
 */

const DELETE_PROGRAMS = new Set(['rm', 'trash', 'unlink', 'rmdir']);
const EXEC_PRIMARIES = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const FILE_OUTPUT_PRIMARIES = new Set(['-fprint', '-fprint0', '-fls', '-fprintf']);
/** Primaries whose next operand is their value, not another primary. */
const VALUE_PRIMARIES = new Set([
  '-name',
  '-iname',
  '-lname',
  '-ilname',
  '-path',
  '-ipath',
  '-wholename',
  '-regex',
  '-iregex',
  '-newer',
  '-anewer',
  '-cnewer',
  '-newermt',
  '-perm',
  '-size',
  '-type',
  '-xtype',
  '-user',
  '-group',
  '-uid',
  '-gid',
  '-inum',
  '-links',
  '-mtime',
  '-ctime',
  '-atime',
  '-mmin',
  '-cmin',
  '-amin',
  '-maxdepth',
  '-mindepth',
  '-samefile',
  '-fstype',
]);

/**
 * Where an `-exec` ends: at `;`, or at a `+` that closes a `{} +` batch.
 *
 * A bare `+` in the middle is one of the child's arguments, not a terminator.
 * Ending there would hand the rest of that child's argv back to find, which is
 * how `-exec echo '+' '-delete' ...` came to look like a delete.
 */
function endOfExec(operands, start) {
  let cursor = start;
  while (cursor < operands.length) {
    const token = operands[cursor];
    if (token === ';') return cursor;
    if (token === '+' && operands[cursor - 1] === '{}') return cursor;
    cursor += 1;
  }
  return cursor;
}

function primaryValueCount(primary) {
  if (primary === '-fprintf') return 2;
  return VALUE_PRIMARIES.has(primary) || FILE_OUTPUT_PRIMARIES.has(primary) || primary === '-printf' ? 1 : 0;
}

/** Output actions open their file even when a preceding predicate never matches. */
export function findOutputAnalysis(words, syntaxComplete = true) {
  let effect = 'read';
  let complete = syntaxComplete && words.every(findWordCannotCreateAction);
  const writes = [];
  const operands = words.map((word) => word.value);
  for (let index = 0; index < words.length; index++) {
    const primary = operands[index];
    if (EXEC_PRIMARIES.has(primary)) {
      index = endOfExec(operands, index + 1);
      continue;
    }
    if (FILE_OUTPUT_PRIMARIES.has(primary)) {
      effect = 'write';
      const file = words[index + 1];
      if (file?.literal) writes.push(file.value);
      else complete = false;
    }
    const count = primaryValueCount(primary);
    if (count && index + count >= words.length) complete = false;
    index += count;
  }
  return {
    handled: true,
    effect: !complete && effect === 'read' ? 'unknown' : effect,
    writes,
    paths: complete ? operands : null,
  };
}

function findWordCannotCreateAction(word) {
  if (stableArgumentWord(word)) return true;
  // A glob such as *.ts is data; a glob that can generate a primary is unproved.
  return (
    /^[*?[]/.test(word.value) &&
    ![...FILE_OUTPUT_PRIMARIES, ...EXEC_PRIMARIES, '-delete'].some((primary) => matchesGlob(primary, word.value))
  );
}

/** Does this `find` argv delete anything? */
export function findArgvDeletes(operands = []) {
  for (let index = 0; index < operands.length; index += 1) {
    const token = operands[index];
    if (primaryValueCount(token)) {
      index += primaryValueCount(token); // Its values are data, whatever they spell.
      continue;
    }
    if (token === '-delete') return true;
    if (!EXEC_PRIMARIES.has(token)) continue;

    const program = operands[index + 1];
    if (program !== undefined && DELETE_PROGRAMS.has(commandName(program) ?? '')) return true;
    // Skip this exec's own arguments so they are not read as find primaries.
    index = endOfExec(operands, index + 1);
  }
  return false;
}

export { DELETE_PROGRAMS };

/** Literal command argv owned by exec primaries; pattern operands remain data. */
export function findExecutedCommands(operands = []) {
  const commands = [];
  for (let index = 0; index < operands.length; index += 1) {
    if (primaryValueCount(operands[index])) {
      index += primaryValueCount(operands[index]);
      continue;
    }
    if (!EXEC_PRIMARIES.has(operands[index])) continue;
    const end = endOfExec(operands, index + 1);
    commands.push({
      args: operands.slice(index + 1, end),
      complete: end < operands.length,
      localCwd: !operands[index].endsWith('dir'),
      stdinUnknown: operands[index].startsWith('-ok'),
    });
    index = end;
  }
  return commands;
}
