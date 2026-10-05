import { inlineMessageSubstitution, readBody, WORD } from './native-effect-heredoc-body.mjs';
import { FOREIGN_INTERPRETERS } from './native-effect-interpreter-source.mjs';
import { segmentCommandText } from './native-effect-segment-locations.mjs';
import { classifyShellSegment, splitShellExecutionSegmentsWithSeparators } from './native-effect-shell-classifier.mjs';
import { commandName, tokenizeSimpleShellCommand } from './native-effect-shell-tokenizer.mjs';

/**
 * Here-documents: the lines after `<<WORD`, up to a line reading WORD, are the standard
 * input of the command carrying the operator -- not command lines. Until 2026-09-27 the
 * guard split them into "commands", so a Python body with `>` and `*` became a write to a
 * glob that can select the runtime, and an apostrophe in a body opened a quote that hid
 * the real commands after it.
 *
 * Each body takes one of three roles, decided by its command:
 * - `data`: the command does not execute its input (it reads, tees, or takes a commit or
 *   PR message) and its output does not become operands (no pipe, no substitution). The
 *   body is dropped from the judged text.
 * - `opaque`: the command is a non-shell interpreter (Python, Node, ...). The body is code
 *   we do not parse, and a path written inside it is not a target of this command: the
 *   command is judged by its argv, cwd and redirections (codex-astra review, 2026-09-27).
 *   The self-host layer still reads the body, because code can signal processes.
 * - `shell`: everything else, including shells, wrappers (`sudo bash`) and read loops. The
 *   body stays in place and is judged line by line, exactly as before.
 *
 * Only a here-document operator at the top level (or in a plain `( … )` group) is read.
 * Any `<<` this lexer does not model -- inside `$( )`, backticks, double quotes or
 * arithmetic, an unsupported delimiter, a missing terminator -- leaves the text exactly as
 * it was, judged line by line as before. Failing to find a here-document is conservative;
 * finding one that is not there would hide commands, so that direction is never guessed.
 *
 * @returns {{judged: string, host: string}} `judged` is the text the target guard splits
 *   into commands; `host` also keeps opaque bodies for the self-host layer.
 */
export function hereDocumentView(raw) {
  const unchanged = { judged: raw, host: raw };
  if (!/<<(?!<)/.test(raw)) return unchanged;
  const layout = separateHereDocuments(raw);
  if (!layout) return unchanged;
  const parts = splitShellExecutionSegmentsWithSeparators(layout.text);
  const roles = layout.heredocs.map((heredoc) => hereDocumentRole(heredoc, parts));
  return {
    judged: reinsert(layout, roles, (role) => role === 'shell'),
    host: reinsert(layout, roles, (role) => role !== 'data'),
  };
}

const DELIMITER = new RegExp(
  String.raw`^<<(-?)[ \t]*(?:'(${WORD})'|"(${WORD})"|\\(${WORD})|(${WORD}))(?=$|[ \t\r\n;&|<>)])`,
);
const OPERATOR_TEXT = /<<-?[ \t]*(?:'[^'\n]*'|"[^"\n]*"|\\?[A-Za-z0-9_][A-Za-z0-9_.-]*)/g;

/** Remove every body (and its terminator line) from the text; null when unsure. */
function separateHereDocuments(raw) {
  const lexer = new HereDocumentLexer(raw);
  while (lexer.index < raw.length) {
    if (lexer.step() === UNSURE) return null;
  }
  return lexer.pending.length > 0 ? null : { text: lexer.text, heredocs: lexer.heredocs };
}

const UNSURE = Symbol('unsure');

/**
 * A lexer for exactly what decides where a body starts: quotes, comments, escapes,
 * substitutions, arithmetic and groups. `stack` holds the open contexts (`sq`, `dq`,
 * `comment`, `subst`, `bt`, `arith`, `group`); `text` is the input with bodies removed.
 */
class HereDocumentLexer {
  constructor(raw) {
    this.raw = raw;
    this.index = 0;
    this.text = '';
    this.stack = [];
    this.pending = [];
    this.heredocs = [];
  }

  get top() {
    return this.stack.at(-1) ?? 'top';
  }

  /** Only a plain `( … )` group keeps the top level's meaning of `<<`. */
  get plain() {
    return this.stack.every((entry) => entry === 'group');
  }

  take(width) {
    this.text += this.raw.slice(this.index, this.index + width);
    this.index += width;
  }

  step() {
    const char = this.raw[this.index];
    if (this.top === 'sq') {
      if (char === "'") this.stack.pop();
      return this.take(1);
    }
    const atLineEnd = char === '\n' || (char === '\r' && this.raw[this.index + 1] === '\n');
    if (this.top === 'comment' && !atLineEnd) return this.take(1);
    if (this.top === 'comment') this.stack.pop();
    if (char === '\\' && this.index + 1 < this.raw.length) return this.take(2);
    if (atLineEnd) return this.lineEnd(char === '\r' ? 2 : 1);
    return this.syntax(char);
  }

  /** After the line that carries operators, their bodies follow in order. */
  lineEnd(width) {
    this.take(width);
    if (this.pending.length === 0) return undefined;
    if (!this.plain) return UNSURE;
    for (const heredoc of this.pending) {
      const body = readBody(this.raw, this.index, heredoc);
      if (!body) return UNSURE;
      this.heredocs.push({ ...heredoc, body: body.body, span: body.span, insertAt: this.text.length });
      this.index = body.next;
    }
    this.pending = [];
    return undefined;
  }

  syntax(char) {
    const rest = this.raw.slice(this.index);
    // A `case` pattern closes a `)` it never opened, so grouping (and whether a body feeds
    // a substitution) is no longer known.
    if (this.top !== 'dq' && /^case\s/.test(rest) && this.atWordStart()) return UNSURE;
    if (rest.startsWith('<<<')) return this.take(3);
    if (rest.startsWith('<<')) return this.operator(rest);
    const inlined = this.plain && char === '"' ? inlineMessageSubstitution(this.raw, this.index) : null;
    if (inlined) {
      this.text += inlined.literal;
      this.index = inlined.next;
      return undefined;
    }
    return this.grouping(char);
  }

  operator(rest) {
    if (!this.plain) return UNSURE;
    const match = DELIMITER.exec(rest);
    if (!match) return UNSURE;
    const delimiter = match[2] ?? match[3] ?? match[4] ?? match[5];
    const quoted = match[5] === undefined;
    this.pending.push({ operatorAt: this.text.length, delimiter, stripTabs: match[1] === '-', quoted });
    return this.take(match[0].length);
  }

  grouping(char) {
    const opened = openerAt(this.raw, this.index, this.top);
    if (opened) {
      this.stack.push(opened.kind);
      return this.take(opened.width);
    }
    const closed = closerAt(this.raw, this.index, this.top);
    if (closed) {
      this.stack.pop();
      return this.take(closed);
    }
    // A `)` that closes nothing we opened: the grouping is no longer known.
    if (char === ')' && this.top !== 'dq' && this.stack.length > 0) return UNSURE;
    return this.take(1);
  }

  atWordStart() {
    return this.index === 0 || /[\s;&|(]/.test(this.raw[this.index - 1]);
  }
}

// Longest first: `$((` is arithmetic before `$(` is a substitution.
const OPENERS = [
  ["'", 'sq'],
  ['"', 'dq'],
  ['$((', 'arith'],
  ['$(', 'subst'],
  ['<(', 'subst'],
  ['>(', 'subst'],
  ['`', 'bt'],
  ['(', 'group'],
];
// Inside double quotes only `$((`, `$(` and backticks open; quotes and parentheses are text.
const DOUBLE_QUOTED_OPENERS = OPENERS.filter(([token]) => ['$((', '$(', '`'].includes(token));

function openerAt(raw, index, top) {
  if (top === 'arith') return raw[index] === '(' ? { kind: 'group', width: 1 } : null;
  const wordStart = index === 0 || /[\s;&|()]/.test(raw[index - 1]);
  if (top !== 'dq' && wordStart && raw[index] === '#') return { kind: 'comment', width: 1 };
  if (top !== 'dq' && wordStart && raw.startsWith('((', index)) return { kind: 'arith', width: 2 };
  const hit = (top === 'dq' ? DOUBLE_QUOTED_OPENERS : OPENERS).find(([token]) => raw.startsWith(token, index));
  // A backtick inside backticks closes them (closerAt).
  if (!hit || (hit[1] === 'bt' && top === 'bt')) return null;
  return { kind: hit[1], width: hit[0].length };
}

function closerAt(raw, index, top) {
  const char = raw[index];
  if (top === 'dq') return char === '"' ? 1 : 0;
  if (top === 'bt') return char === '`' ? 1 : 0;
  if (top === 'arith') return raw.startsWith('))', index) ? 2 : 0;
  if (top === 'subst' || top === 'group') return char === ')' ? 1 : 0;
  return 0;
}

function hereDocumentRole(heredoc, parts) {
  const ownerIndex = parts.findIndex((part) => part.start <= heredoc.operatorAt && heredoc.operatorAt < part.end);
  if (ownerIndex < 0) return 'shell';
  // An unquoted delimiter expands `$( )` and backticks in the body: they run.
  if (!heredoc.quoted && /\$\(|`/.test(heredoc.body)) return 'shell';
  if (['|', '|&'].includes(parts[ownerIndex + 1]?.separator)) return 'shell';
  const command = ownerCommand(parts[ownerIndex].text);
  const tokens = tokenizeSimpleShellCommand(command);
  if (tokens && FOREIGN_INTERPRETERS.test(commandName(tokens[0]) ?? '')) return 'opaque';
  if (tokens && consumesInputAsData(tokens, command)) return 'data';
  return 'shell';
}

/** The owner's own command: no grouping, no here-document operators, no output redirections. */
function ownerCommand(text) {
  return segmentCommandText(text)
    .replace(OPERATOR_TEXT, ' ')
    .replace(/(?:^|\s)(?:\d*>{1,2}\|?|&>>?)\s*(?:"[^"]*"|'[^']*'|[^\s;&|<>]+)/g, ' ')
    .trim();
}

function consumesInputAsData(tokens, command) {
  const program = commandName(tokens[0]);
  if (program === 'git') return takesMessageFromInput(tokens, ['-F', '--file'], GIT_MESSAGE_COMMANDS);
  if (program === 'gh') return takesMessageFromInput(tokens, ['-F', '--body-file'], GH_MESSAGE_COMMANDS);
  if (program === 'tee') return !namesInputAsFile(tokens);
  if (INPUT_RUNNING_READERS.has(program)) return false;
  return classifyShellSegment(command) === 'read' && !namesInputAsFile(tokens);
}

// A read-classified program whose script decides whether its input runs: GNU sed's `e` command
// and `s///e` flag execute the pattern space. What it reads is never plain data.
const INPUT_RUNNING_READERS = new Set(['sed', 'gsed']);

const GIT_MESSAGE_COMMANDS = new Set(['commit', 'tag', 'notes', 'merge']);
const GH_MESSAGE_COMMANDS = new Set(['pr', 'issue']);

/** `git commit -F -`, `gh pr comment --body-file -`: standard input is the message. */
function takesMessageFromInput(tokens, options, commands) {
  const command = tokens
    .slice(1)
    .find((token, index, rest) => !token.startsWith('-') && !['-c', '-C'].includes(rest[index - 1]));
  if (!commands.has(command)) return false;
  return tokens.some(
    (token, index) =>
      options.some(
        (option) =>
          token === `${option}=-` ||
          (!option.startsWith('--') && token === `${option}-`) ||
          (token === option && tokens[index + 1] === '-'),
      ) && !tokens.some((other) => /^--(?:stdin|batch)/.test(other)),
  );
}

/**
 * An option reads standard input as a file (a script, patterns, a filter), so what arrives
 * there is not plain input. One option, every spelling (codex-astra review of #4840): the
 * value attached (`-f-`, `-nf-`, `-f/dev/stdin`), separate (`-f -`), or after `=`
 * (`--file=-`), and any device path that is standard input.
 */
function namesInputAsFile(tokens) {
  return tokens.some(
    (token, index) =>
      /(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/.test(token) ||
      /^-[A-Za-z]+-$/.test(token) ||
      /^--[A-Za-z][\w-]*=-$/.test(token) ||
      (token === '-' && index > 1 && /^-{1,2}[A-Za-z]/.test(tokens[index - 1])),
  );
}

function reinsert(layout, roles, keep) {
  let result = '';
  let cursor = 0;
  layout.heredocs.forEach((heredoc, index) => {
    result += layout.text.slice(cursor, heredoc.insertAt);
    cursor = heredoc.insertAt;
    if (keep(roles[index])) result += heredoc.span;
  });
  return result + layout.text.slice(cursor);
}
