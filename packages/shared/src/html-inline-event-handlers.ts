/**
 * #1640: Author-side diagnosis for html_widget inline event handler attributes.
 *
 * sanitizeWidgetHtml (packages/ui) strips every `on*` attribute before the widget
 * reaches the iframe — buttons render but clicks silently do nothing. This finds
 * such attributes at publish time so the authoring cat can switch to
 * addEventListener. It is a prediction about the sanitizer, not proof that a
 * browser removed anything.
 *
 * Detection follows HTML tokenizer semantics instead of a substring search:
 * only attribute names of real start tags count. Comments, doctype/bogus
 * comments, end tags, plain text and raw-text element bodies (<script>, <style>,
 * <textarea>, <title>, …) are skipped, so `"onclick"` inside JS strings, comments
 * or prose is not reported. DOMPurify parses through DOMParser (scripting off),
 * so <noscript> content is markup, and <script>/<style> inside <svg>/<math> are
 * not raw text. Script-data escape states (`<!--<script>` nesting) are not
 * modelled; their content is treated as plain script text.
 */

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'textarea', 'title']);
const FOREIGN_ROOTS = new Set(['svg', 'math']);
const FOREIGN_RAW_TEXT_EXEMPT = new Set(['script', 'style']);
const INLINE_EVENT_HANDLER_NAME = /^on[a-z]+$/;

const isWhitespace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
const isAsciiAlpha = (ch: string | undefined) => ch !== undefined && /^[A-Za-z]$/.test(ch);

interface ParsedTag {
  name: string;
  attributeNames: string[];
  selfClosing: boolean;
  end: number;
}

const isNameEnd = (ch: string | undefined) => isWhitespace(ch) || ch === '/' || ch === '>';

function skipWhile(html: string, pos: number, keep: (ch: string | undefined) => boolean): number {
  let i = pos;
  while (i < html.length && keep(html[i])) i++;
  return i;
}

/** `pos` points just after `=`; returns the index after the (quoted or unquoted) value. */
function skipAttributeValue(html: string, pos: number): number {
  const i = skipWhile(html, pos, isWhitespace);
  const quote = html[i];
  if (quote !== '"' && quote !== "'") return skipWhile(html, i, (ch) => !isWhitespace(ch) && ch !== '>');
  const close = html.indexOf(quote, i + 1);
  return close === -1 ? html.length : close + 1;
}

/** Tokenize one tag starting right after `<` or `</`; `pos` points at the first name char. */
function parseTag(html: string, pos: number): ParsedTag {
  let i = skipWhile(html, pos, (ch) => !isNameEnd(ch));
  const name = html.slice(pos, i).toLowerCase();
  const attributeNames: string[] = [];
  let selfClosing = false;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '>') return { name, attributeNames, selfClosing, end: i + 1 };
    selfClosing = ch === '/' && html[i + 1] === '>';
    if (isWhitespace(ch) || ch === '/') {
      i++;
      continue;
    }
    // Attribute name: a leading `=` belongs to the name (spec parse error recovery).
    const nameEnd = skipWhile(html, i + 1, (c) => !isNameEnd(c) && c !== '=');
    attributeNames.push(html.slice(i, nameEnd).toLowerCase());
    i = skipWhile(html, nameEnd, isWhitespace);
    if (html[i] === '=') i = skipAttributeValue(html, i + 1);
  }
  return { name, attributeNames, selfClosing, end: html.length };
}

/** Index just past the closing `</name` tag of a raw-text element, or the end of input. */
function skipRawText(html: string, lower: string, pos: number, name: string): number {
  let i = pos;
  while (true) {
    const close = lower.indexOf(`</${name}`, i);
    if (close === -1) return html.length;
    const after = html[close + 2 + name.length];
    if (after === undefined || isWhitespace(after) || after === '/' || after === '>') return close;
    i = close + 2;
  }
}

function skipComment(html: string, pos: number): number {
  // pos points just after `<!--`; `<!-->` and `<!--->` close immediately.
  if (html[pos] === '>') return pos + 1;
  if (html.startsWith('->', pos)) return pos + 2;
  const candidates = [html.indexOf('-->', pos), html.indexOf('--!>', pos)].filter((n) => n !== -1);
  if (candidates.length === 0) return html.length;
  const close = Math.min(...candidates);
  return close + (html.startsWith('-->', close) ? 3 : 4);
}

function skipToGreaterThan(html: string, pos: number): number {
  const close = html.indexOf('>', pos);
  return close === -1 ? html.length : close + 1;
}

interface ScanState {
  readonly html: string;
  /** ASCII-only lowercasing keeps indices aligned with `html`. */
  readonly lower: string;
  readonly found: string[];
  foreignDepth: number;
}

/** Handles a start tag at `<`; returns where scanning resumes (html.length stops it). */
function scanStartTag(state: ScanState, lt: number): number {
  const tag = parseTag(state.html, lt + 1);
  for (const name of tag.attributeNames) {
    if (INLINE_EVENT_HANDLER_NAME.test(name) && !state.found.includes(name)) state.found.push(name);
  }
  if (FOREIGN_ROOTS.has(tag.name) && !tag.selfClosing) state.foreignDepth++;
  if (tag.name === 'plaintext') return state.html.length;
  const foreignExempt = state.foreignDepth > 0 && FOREIGN_RAW_TEXT_EXEMPT.has(tag.name);
  if (!RAW_TEXT_ELEMENTS.has(tag.name) || foreignExempt) return tag.end;
  return skipRawText(state.html, state.lower, tag.end, tag.name);
}

function scanEndTag(state: ScanState, lt: number): number {
  if (!isAsciiAlpha(state.html[lt + 2])) return skipToGreaterThan(state.html, lt + 2);
  const tag = parseTag(state.html, lt + 2);
  if (FOREIGN_ROOTS.has(tag.name) && state.foreignDepth > 0) state.foreignDepth--;
  return tag.end;
}

/**
 * Returns unique inline event handler attribute names (lowercased, source order)
 * found on start tags. Attribute values are never returned.
 */
export function findInlineEventHandlerAttributes(html: string): string[] {
  const state: ScanState = {
    html,
    lower: html.replace(/[A-Z]/g, (ch) => ch.toLowerCase()),
    found: [],
    foreignDepth: 0,
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const next = html[lt + 1];
    if (html.startsWith('<!--', lt)) i = skipComment(html, lt + 4);
    else if (next === '!' || next === '?') i = skipToGreaterThan(html, lt + 2);
    else if (next === '/') i = scanEndTag(state, lt);
    else if (isAsciiAlpha(next)) i = scanStartTag(state, lt);
    else i = lt + 1;
  }
  return state.found;
}
