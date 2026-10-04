import { commandName, shellWords } from './native-effect-shell-tokenizer.mjs';

/**
 * Code handed to a non-shell interpreter is source, not operands (codex-astra ruling,
 * thread_muj3x2kabkbmx42l, 2026-09-27): a path written inside `python3 -c "…"` or
 * `node -e '…'` is not a target of the shell command. The guard does not read these
 * languages, so the effect stays unknown; the command's own operands, working directory
 * and redirections are judged as before. `sh -c` / `bash -c` are not here: they carry shell
 * commands and stay judged as shell.
 *
 * Only spellings this module is sure of are recognised. Anything else -- a clustered flag it
 * does not know, a substitution in the command -- leaves the text unchanged, which keeps the
 * code in view (the conservative direction).
 */
export const FOREIGN_INTERPRETERS = /^(?:python\d*(?:\.\d+)?|pypy\d*|node|nodejs|ruby|perl|php|deno|bun|osascript)$/;

// Per interpreter family: options whose value is the code, and clusters that end in one.
const CODE_OPTIONS = [
  {
    family: /^(?:python\d*(?:\.\d+)?|pypy\d*)$/,
    separate: ['-c'],
    attached: ['-c'],
    terminates: true,
    values: ['-X', '-W', '--check-hash-based-pycs'],
    valueAttached: ['-X', '-W'],
    flags: /^-[bBdEhiIOPqRsSuvVx]+$/,
  },
  {
    family: /^(?:node|nodejs)$/,
    separate: ['-e', '--eval', '-p', '--print'],
    equals: ['--eval', '--print'],
    values: ['-r', '--require', '--import', '--input-type', '--loader', '--experimental-loader'],
    valueAttached: ['-r'],
    flags: /^--(?:no-warnings|trace-warnings|use-strict)$/,
  },
  { family: /^bun$/, separate: ['-e', '--eval'], equals: ['--eval'] },
  { family: /^perl$/, separate: ['-e', '-E'], cluster: /^-[lnpaw0-9]*[eE]$/, flags: /^-[lnpawpi0-9]+$/ },
  { family: /^ruby$/, separate: ['-e'], cluster: /^-[lnpaw]*e$/, flags: /^-[lnpaw]+$/ },
  { family: /^php$/, separate: ['-r'] },
  { family: /^osascript$/, separate: ['-e'] },
];

/** The segment with each code argument replaced by `''`; unchanged when unsure. */
export function withoutInterpreterSource(segment) {
  // Redirection syntax ends argv, not the already-read code argument. Its raw
  // suffix stays in the segment and is still judged as a shell write target.
  const words = shellWords(segment, { prefixOnly: true });
  if (!words || words.length < 2) return segment;
  const programIndex = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value));
  if (programIndex < 0) return segment;
  const program = commandName(words[programIndex].value) ?? '';
  const spans = program === 'deno' ? denoEvalSpans(words, programIndex) : codeSpans(words, programIndex, program);
  if (spans.length === 0) return segment;
  let text = '';
  let cursor = 0;
  for (const span of spans) {
    text += `${segment.slice(cursor, span.start)}''`;
    cursor = span.end;
  }
  return text + segment.slice(cursor);
}

function codeSpans(words, programIndex, program) {
  const options = CODE_OPTIONS.find((entry) => entry.family.test(program));
  if (!options) return [];
  const spans = [];
  for (let index = programIndex + 1; index < words.length; index += 1) {
    if (words[index].value === '--') return spans;
    const code = codeArgument(options, words[index], words[index + 1]);
    if (code) {
      if (!code.span) return spans;
      spans.push(code.span);
      index += code.consumed;
      if (options.terminates) return spans;
      continue;
    }
    const consumed = nonCodeOptionArity(options, words[index].value, words[index + 1]);
    // A script/argument or unknown option arity ends our readable option prefix.
    if (consumed === undefined) return spans;
    index += consumed;
  }
  return spans;
}

function codeArgument(options, word, next) {
  const value = word.value;
  if (options.separate.includes(value) || options.cluster?.test(value)) return { span: next, consumed: 1 };
  if (
    options.equals?.some((option) => value.startsWith(`${option}=`)) ||
    options.attached?.some((option) => value.startsWith(option) && value.length > option.length)
  ) {
    return { span: word, consumed: 0 };
  }
  return null;
}

/** Keep all non-code values in the judged text, including real preload paths. */
function nonCodeOptionArity(options, value, next) {
  if (options.values?.includes(value)) return next ? 1 : undefined;
  if (
    options.values?.some((option) => value.startsWith(`${option}=`)) ||
    options.valueAttached?.some((option) => value.startsWith(option) && value.length > option.length) ||
    options.flags?.test(value)
  )
    return 0;
  return undefined;
}

/** `deno eval '<code>'`. */
function denoEvalSpans(words, programIndex) {
  return words[programIndex + 1]?.value === 'eval' && words[programIndex + 2] ? [words[programIndex + 2]] : [];
}
