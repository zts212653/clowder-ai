import { commandName } from './native-effect-shell-tokenizer.mjs';

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

/** Does this `find` argv delete anything? */
export function findArgvDeletes(operands = []) {
  for (let index = 0; index < operands.length; index += 1) {
    const token = operands[index];
    if (VALUE_PRIMARIES.has(token)) {
      index += 1; // Its value is data, whatever it happens to spell.
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
