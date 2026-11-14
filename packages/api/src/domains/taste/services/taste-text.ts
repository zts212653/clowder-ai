/**
 * Every committed Taste file passes the repository's pre-commit whitespace guard, which flags ASCII
 * blanks (space, tab, CR, VT, FF) at a line end; a no-break space is content and stays. Apply this to
 * text values before they are serialized, and to hand-written Markdown/YAML lines whose values cannot
 * end a physical line with an escape. Never strip a YAML library's output: a folded double-quoted
 * scalar can end a line with an escaped space, and removing it turns the escape into a continuation.
 */
export function withoutTrailingWhitespace(text: string): string {
  // Split on LF only: a multiline regex would also treat CR, U+2028 and U+2029 as line ends.
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\r\v\f]+$/, ''))
    .join('\n');
}

/** Text placed on one Markdown list line: line breaks and runs of whitespace collapse to one space. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
