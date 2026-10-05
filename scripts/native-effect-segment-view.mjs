import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { kernelPath, unfoldedJoin } from './lib/shell-directory.mjs';
import { withoutInterpreterSource } from './native-effect-interpreter-source.mjs';
import { commandName, shellInvocation, shellWords } from './native-effect-shell-tokenizer.mjs';
import { fileProgramAnalysis } from './native-effect-write-effects.mjs';

/**
 * What one segment acts on, as the shell will run it: the command text whose operands are
 * judged, and the directory it runs in.
 *
 * - `git -C <dir> …` runs git in <dir> (git chdir()s there, so the kernel resolves it
 *   physically): the same as `cd <dir> && git …`. The directory is context, not a target
 *   (slice 2b; the git-context module already does this for the chains it parses exactly).
 * - Code handed to a non-shell interpreter is source, not operands
 *   (native-effect-interpreter-source.mjs).
 * - A file command that acts only on its operands (`mkdir`, `cp`, `rm`, `tee` …) does not
 *   act on its working directory when every operand is absolute: `mkdir -p /tmp/probe`
 *   run from inside the runtime writes to /tmp. `targetCwd` is then undefined.
 *
 * Whatever is not read with certainty -- a `-C` value with a variable, a tilde or a
 * substitution, `-C` after another global option -- leaves the segment unchanged.
 */
export function segmentView(segment, location) {
  const program = shellInvocation(segment).words[0];
  const named =
    program && /^\/(?:usr\/)?s?bin\/[^/]+$/.test(program.value)
      ? segment.slice(0, program.start) + commandName(program.value) + segment.slice(program.end)
      : segment;
  const context = gitDirectoryContext(named, location);
  const command = withoutGhMessageData(withoutInterpreterSource(context.command));
  // File roles parsed from text do not attest the executing shell/program.
  // Keep cwd for sort/sed writes until the executor supplies that missing fact.
  const targetCwd = actsOnlyOnAbsoluteOperands(command) ? undefined : context.location;
  return { command, location: context.location, targetCwd, targetText: withObservedWriteAliases(command) };
}

function withObservedWriteAliases(command) {
  const writes = fileProgramAnalysis(command).writes ?? [];
  const aliases = writes
    .filter((path) => typeof path === 'string' && isAbsolute(path))
    .flatMap((path) => {
      const physical = kernelPath(path);
      const parent = physical ? null : kernelPath(dirname(path));
      return physical ? [physical] : parent ? [join(parent, basename(path))] : [];
    });
  // Observation can add a protected target, never remove the original command
  // or cwd. A stale namespace observation cannot grant an exclusion this way.
  return [command, ...aliases.map((path) => JSON.stringify(path))].join(' ');
}

// GitHub CLI metadata is text, whereas --body-file/--template are real paths.
// This removes only proven data operands; it does not authorize a remote operation.
const GH_DATA = new Set(['--body', '-b', '--title', '-t']);
const GH_VALUES = new Set([
  ...GH_DATA,
  '--repo',
  '-R',
  '--base',
  '-B',
  '--head',
  '-H',
  '--body-file',
  '-F',
  '--template',
  '-T',
  '--assignee',
  '-a',
  '--label',
  '-l',
  '--milestone',
  '-m',
  '--project',
  '-p',
  '--reviewer',
  '-r',
  '--recover',
  '--add-assignee',
  '--remove-assignee',
  '--add-label',
  '--remove-label',
  '--add-project',
  '--remove-project',
  '--add-reviewer',
  '--remove-reviewer',
]);
const GH_FLAGS = new Set([
  '--draft',
  '-d',
  '--dry-run',
  '--editor',
  '-e',
  '--fill',
  '-f',
  '--fill-first',
  '--fill-verbose',
  '--no-maintainer-edit',
  '--web',
  '-w',
  '--help',
  '--create-if-none',
  '--delete-last',
  '--edit-last',
  '--yes',
  '--remove-milestone',
]);

function withoutGhMessageData(raw) {
  const { words, complete } = shellInvocation(raw);
  if (
    !complete ||
    words?.[0]?.value !== 'gh' ||
    !['pr', 'issue'].includes(words[1]?.value) ||
    !['create', 'edit', 'comment'].includes(words[2]?.value)
  )
    return raw;
  const spans = [];
  for (let index = 3; index < words.length; index += 1) {
    const word = words[index];
    if (word.value === '--') break;
    if (!word.value.startsWith('-')) continue; // PR/issue number, URL or branch.
    const option = ghOption(words, index);
    if (!option) return raw; // Unknown option arity is not guessed.
    if (GH_DATA.has(option.flag)) {
      const data = words[option.endIndex];
      // A redirection may separate an option from its value. Replace only the data word.
      const replacement = index === option.endIndex ? `${option.flag} ''` : "''";
      spans.push({ start: data.start, end: data.end, replacement });
    }
    index = option.endIndex;
  }
  for (const span of spans.reverse()) raw = raw.slice(0, span.start) + span.replacement + raw.slice(span.end);
  return raw;
}

function ghOption(words, index) {
  const word = words[index].value;
  const equals = word.indexOf('=');
  if (GH_FLAGS.has(word)) return { flag: word, endIndex: index };
  const attached = equals < 0 && word.length > 2 && GH_VALUES.has(word.slice(0, 2));
  const flag = attached ? word.slice(0, 2) : word.split('=', 1)[0];
  if (!GH_VALUES.has(flag)) return null;
  const endIndex = equals >= 0 || attached ? index : index + 1;
  return words[endIndex] ? { flag, endIndex } : null;
}

const OPERAND_PROGRAMS = new Set([
  'mkdir',
  'touch',
  'cp',
  'mv',
  'rm',
  'rmdir',
  'trash',
  'unlink',
  'tee',
  'install',
  'ln',
]);

function actsOnlyOnAbsoluteOperands(command) {
  const words = shellWords(command);
  if (!words || !OPERAND_PROGRAMS.has(words[0]?.value)) return false;
  const operands = words.slice(1).filter((word) => !word.value.startsWith('-'));
  return operands.length > 0 && operands.every((word) => isAbsolute(word.value) && !/[*?[{$`~]/.test(word.value));
}

function gitDirectoryContext(segment, location) {
  const unchanged = { command: segment, location };
  const words = shellWords(segment, { prefixOnly: true });
  if (!words || words[0]?.value !== 'git') return unchanged;
  let directory = location;
  let index = 1;
  const dropped = [];
  while (words[index]?.value === '-C' && words[index + 1]) {
    const value = words[index + 1].value;
    if (!value || /[$`~]/.test(value)) return unchanged;
    if (!isAbsolute(value) && directory === undefined) return unchanged;
    const joined = unfoldedJoin(directory ?? '/', value);
    directory = kernelPath(joined) ?? resolve(joined);
    dropped.push({ start: words[index].start, end: words[index + 1].end });
    index += 2;
  }
  if (dropped.length === 0) return unchanged;
  let command = '';
  let cursor = 0;
  for (const span of dropped) {
    command += segment.slice(cursor, span.start);
    cursor = span.end;
  }
  return {
    command: (command + segment.slice(cursor)).replace(/\s+/g, ' ').trim(),
    location: kernelPath(directory) ?? directory,
  };
}
