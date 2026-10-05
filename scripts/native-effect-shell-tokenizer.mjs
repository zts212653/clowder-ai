/** `/dev/null` and fd duplication are sinks, not mutations of the command's cwd. */
export function stripHarmlessRedirections(raw) {
  return raw.replace(/(?:^|\s)(?:\d*>{1,2}\s*\/dev\/null|\d*>\s*&\s*\d+)(?=\s|$)/g, ' ');
}

export function tokenizeSimpleShellCommand(raw) {
  // A substitution makes a command unreadable -- but only a real one: inside single quotes
  // `x` and $(x) are literal text (a markdown code span in a commit message, 2026-09-27).
  if (/`|\$\(|[<>]\(/.test(unquotedShellText(raw))) return null;
  const tokenPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|((?:\\.|[^\s"'\\])+)/g;
  const tokens = [];
  let cursor = 0;
  for (const match of raw.matchAll(tokenPattern)) {
    if (raw.slice(cursor, match.index).trim()) return null;
    tokens.push(decodeShellToken(match));
    cursor = (match.index ?? 0) + match[0].length;
  }
  return raw.slice(cursor).trim() ? null : tokens;
}

function decodeShellToken(match) {
  if (match[2] !== undefined) return match[2];
  return (match[1] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
}

/**
 * The text the shell reads as syntax, with quoted text blanked out. A double-quoted
 * string that substitutes a command is kept whole, and an unterminated quote keeps
 * everything: both can still hide real syntax.
 */
export function unquotedShellText(raw) {
  let text = '';
  let index = 0;
  while (index < raw.length) {
    const piece = shellPieceAt(raw, index);
    if (!piece) return raw;
    text += piece.text;
    index = piece.next;
  }
  return text;
}

/** One escape, quoted string or plain character; null for an unterminated quote. */
function shellPieceAt(raw, index) {
  const char = raw[index];
  if (char === '\\') return { text: '  ', next: index + 2 };
  if (char === "'") {
    const end = raw.indexOf("'", index + 1);
    return end < 0 ? null : { text: "''", next: end + 1 };
  }
  if (char !== '"') return { text: char, next: index + 1 };
  let end = index + 1;
  while (end < raw.length && raw[end] !== '"') end += raw[end] === '\\' ? 2 : 1;
  if (end >= raw.length) return null;
  const quoted = raw.slice(index, end + 1);
  return { text: /\$\(|`/.test(quoted) ? quoted : '""', next: end + 1 };
}

export function commandName(raw) {
  return raw?.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase();
}

/** Blank real comments without changing offsets; quoted/escaped # remains word data. */
export function stripShellComments(raw) {
  let text = '';
  let cursor = 0;
  let wordStart = true;
  for (let index = 0; index < raw.length; ) {
    const piece = commentPiece(raw, index, wordStart);
    if (!piece) return raw;
    if (piece.comment) {
      text += raw.slice(cursor, index) + ' '.repeat(piece.next - index);
      cursor = piece.next;
    }
    index = piece.next;
    wordStart = piece.wordStart;
  }
  return text + raw.slice(cursor);
}

function commentPiece(raw, index, wordStart) {
  const char = raw[index];
  // Substitution boundaries need their own shell context. Do not let an inner
  // comment erase a closing backtick and an executable outer suffix.
  if (char === '`' || raw.startsWith('$(', index)) return null;
  if (char === '\\') return { next: index + 2, wordStart: raw[index + 1] === '\n' && wordStart };
  if (char === "'" || char === '"') {
    const piece = wordPiece(raw, index);
    return piece ? { next: piece.next, wordStart: false } : null;
  }
  if (char === '#' && wordStart) {
    const newline = raw.indexOf('\n', index);
    return { next: newline < 0 ? raw.length : newline, wordStart: true, comment: true };
  }
  return { next: index + 1, wordStart: /[\s;&|<>()]/.test(char) };
}

/**
 * Words of one simple command with their raw spans. Null when the command holds anything this
 * reader does not model outside single quotes (a substitution, an unterminated quote).
 * prefixOnly retains complete leading words for context options before shell syntax;
 * it does not certify the rest of that command as parsed.
 */
export function shellWords(raw, { prefixOnly = false } = {}) {
  const words = [];
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    if (index >= raw.length) break;
    const start = index;
    let value = '';
    while (index < raw.length && !/\s/.test(raw[index])) {
      const piece = wordPiece(raw, index);
      if (!piece) return prefixOnly ? words : null;
      value += piece.value;
      index = piece.next;
    }
    words.push({ value, start, end: index });
  }
  return words;
}

/** A complete literal argv, separate from redirection operands. Never certifies a prefix. */
export function shellInvocation(raw) {
  raw = stripShellComments(raw);
  const result = { words: [], redirections: [], complete: false, syntaxComplete: false };
  let index = 0;
  while (index < raw.length) {
    index = skipBlanks(raw, index);
    if (index >= raw.length) break;
    const item = invocationItem(raw, index);
    if (!item) return result;
    if (item.operator) result.redirections.push(item);
    else result.words.push(item);
    index = item.end;
  }
  result.syntaxComplete = true;
  result.complete = result.words.every((word) => word.literal) && result.redirections.every((r) => r.operand.literal);
  return result;
}

function skipBlanks(raw, index) {
  while (index < raw.length) {
    if (/[ \t]/.test(raw[index])) index += 1;
    else if (raw.startsWith('\\\n', index)) index += 2;
    else break;
  }
  return index;
}

function invocationItem(raw, start) {
  // Named descriptors are shell syntax, not an argv word; leave them unparsed for now.
  if (/^\{\w+\}[<>]/.test(raw.slice(start))) return null;
  const redirect = /^(?:\d*(?:<>|>>|>\||>&|<&|>|<)|&>>?)/.exec(raw.slice(start));
  if (!redirect) return invocationWord(raw, start);
  const operand = invocationWord(raw, skipBlanks(raw, start + redirect[0].length));
  return operand ? { operator: redirect[0], operand, start, end: operand.end } : null;
}

function invocationWord(raw, start) {
  if (raw[start] === '#') return null;
  let index = start;
  let value = '';
  let literal = true;
  let literalPrefix = '';
  while (index < raw.length && !/[\s;&|<>()]/.test(raw[index])) {
    // Pure word expansion changes argv cardinality, but not shell execution syntax.
    // Keep its role evidence without claiming an exact expanded word.
    const expands = /[*?[\]{}~^#]/.test(raw[index]) || (index === start && raw[index] === '=');
    const piece = expands ? { value: raw[index], next: index + 1 } : wordPiece(raw, index, true);
    if (!piece) return null;
    if (expands && literal) {
      literal = false;
      literalPrefix = value;
    }
    value += piece.value;
    index = piece.next;
  }
  return index > start ? { value, start, end: index, literal, literalPrefix: literal ? value : literalPrefix } : null;
}

function wordPiece(raw, index, literalOnly = false) {
  const char = raw[index];
  if (char === "'") {
    const end = raw.indexOf("'", index + 1);
    return end < 0 ? null : { value: raw.slice(index + 1, end), next: end + 1 };
  }
  if (char === '"') return doubleQuotedWord(raw, index, literalOnly);
  if (char === '\\') {
    if (index + 1 >= raw.length) return null;
    return { value: literalOnly && raw[index + 1] === '\n' ? '' : raw[index + 1], next: index + 2 };
  }
  // Outside quotes, shell expansion can change a word or generate multiple argv
  // entries. Do not certify it from spelling alone (including optional zsh globs).
  if (literalOnly && /[$*?[\]{}~^#]/.test(char)) return null;
  if (char === '`' || raw.startsWith('$(', index) || /[;&|<>()]/.test(char)) return null;
  return { value: char, next: index + 1 };
}

function doubleQuotedWord(raw, index, literalOnly) {
  let end = index + 1;
  let value = '';
  while (end < raw.length && raw[end] !== '"') {
    if (raw[end] === '\\' && end + 1 < raw.length) {
      value += doubleQuotedEscape(raw[end + 1], literalOnly);
      end += 2;
    } else {
      if (raw[end] === '`' || raw.startsWith('$(', end) || (literalOnly && raw[end] === '$')) return null;
      value += raw[end++];
    }
  }
  return end >= raw.length ? null : { value, next: end + 1 };
}

function doubleQuotedEscape(char, literalOnly) {
  if (!literalOnly) return char;
  if (char === '\n') return '';
  return /[$`"\\]/.test(char) ? char : `\\${char}`;
}
