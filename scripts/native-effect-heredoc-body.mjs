/**
 * Reading a here-document body (for native-effect-heredoc.mjs), and the one substitution
 * whose value is known without running it: a message passed as "$(cat <<'EOF' … EOF)".
 */
export const WORD = '[A-Za-z0-9_][A-Za-z0-9_.-]*';

const MESSAGE_SUBSTITUTION = new RegExp(
  String.raw`^"\$\(cat[ \t]+<<(-?)[ \t]*(?:'(${WORD})'|"(${WORD})"|\\(${WORD}))[ \t]*\r?\n`,
);

/**
 * `"$(cat <<'EOF' … EOF)"` -- the usual way to pass a multi-line commit or PR message --
 * expands to exactly its body, as one word, with trailing newlines removed. Replacing it
 * with that body as a single-quoted literal keeps the word, so operands stay visible
 * (`rm -rf "$(cat <<'EOF' …)"` still names its target) while the message stops being an
 * unreadable substitution. Only the quoted-delimiter form qualifies: it expands nothing.
 *
 * macOS /bin/bash is 3.2, which finds the end of `$( … )` by scanning brackets, quotes and
 * comments rather than parsing: a `)` in the body that closes nothing it opened ends the
 * substitution early, and the rest of the body runs (a backtick in it executes). zsh and
 * bash 5 read the body as literal. So only a body that such a scan crosses is inlined.
 */
export function inlineMessageSubstitution(raw, index) {
  const match = MESSAGE_SUBSTITUTION.exec(raw.slice(index, index + 300));
  if (!match) return null;
  const heredoc = { delimiter: match[2] ?? match[3] ?? match[4], stripTabs: match[1] === '-' };
  const body = readBody(raw, index + match[0].length, heredoc);
  const close =
    body && survivesBracketScan(body.body, raw.slice(body.next)) && /^[ \t\r\n]*\)"/.exec(raw.slice(body.next));
  if (!close) return null;
  const lines = body.body.split('\n').map((line) => (heredoc.stripTabs ? line.replace(/^\t+/, '') : line));
  const value = lines.join('\n').replace(/(?:\r?\n)+$/, '');
  // Apostrophes and backslashes become spaces, so every quote-aware reader (this guard,
  // the F300 self-host parser) sees one plain single-quoted word. Neither character can
  // be part of a protected name, and a space only separates words: a protected name in
  // the body can match more easily, never less.
  return { literal: `'${value.replace(/['\\]/g, ' ')}'`, next: body.next + close[0].length };
}

/**
 * Does a bracket-scanning shell (bash 3.2) close this substitution exactly where zsh and
 * bash 5 do? Measured on /bin/bash 3.2 (2026-09-27): quotes and escapes hide brackets; a
 * `#` at a line start or after a space or tab hides brackets up to the newline, but a quote
 * character still opens a quote there, and the comment goes on after that quote closes;
 * `#` after anything else (`a#`, `(#`, `$#`) is not a comment. The brackets must balance.
 *
 * A quote the body leaves open (`it's`) is safe only if its character never appears again
 * in the command: bash 3.2 then fails at the end of input and runs nothing after it. If it
 * does appear, bash 3.2 closes the quote there and reads everything after it differently
 * (the oracle found a second message whose body then ran). Not mirrored, so refused: a
 * backslash in a comment, and a quote that opens in a comment and runs past its line.
 */
function survivesBracketScan(body, after) {
  const scan = { depth: 0, comment: false };
  for (let index = 0; index < body.length; index += 1) {
    const step = bracketStep(body, index, after, scan);
    if (typeof step === 'boolean') return step;
    index = step;
  }
  return scan.depth === 0;
}

/** One character of the scan: the index to go on from, or the final answer. */
function bracketStep(body, index, after, scan) {
  const char = body[index];
  if (char === '\n') {
    scan.comment = false;
    return index;
  }
  if (char === '\\') return scan.comment ? false : index + 1;
  if (char === "'" || char === '"' || char === '`') return quoteStep(body, index, after, scan.comment);
  if (scan.comment) return index;
  scan.comment = char === '#' && (index === 0 || /[ \t\n]/.test(body[index - 1]));
  if (char === '(') scan.depth += 1;
  if (char === ')') scan.depth -= 1;
  return scan.depth < 0 ? false : index;
}

function quoteStep(body, open, after, inComment) {
  const close = closingQuote(body, open);
  if (close < 0) return !`${body.slice(open + 1)}${after}`.includes(body[open]);
  return inComment && body.slice(open, close).includes('\n') ? false : close;
}

function closingQuote(text, open) {
  const quote = text[open];
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === '\\' && quote !== "'") index += 1;
    else if (text[index] === quote) return index;
  }
  return -1;
}

/** The body runs from `start` to the line equal to the delimiter; bash reads nothing else. */
export function readBody(raw, start, heredoc) {
  let cursor = start;
  while (cursor < raw.length) {
    const newline = raw.indexOf('\n', cursor);
    const end = newline < 0 ? raw.length : newline;
    const next = newline < 0 ? raw.length : newline + 1;
    let line = raw.slice(cursor, end).replace(/\r$/, '');
    if (heredoc.stripTabs) line = line.replace(/^\t+/, '');
    if (line === heredoc.delimiter) {
      return { body: raw.slice(start, cursor), span: raw.slice(start, next), next };
    }
    cursor = next;
  }
  return null;
}
