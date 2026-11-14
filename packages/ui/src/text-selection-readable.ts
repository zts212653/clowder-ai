/** Clip by selected characters, not the pointer's final release geometry. */
export function clippedRangeWithin(range: Range, candidate: Element): Range | null {
  try {
    if (!range.intersectsNode(candidate)) return null;
    const bounds = document.createRange();
    bounds.selectNodeContents(candidate);
    const overlap = range.cloneRange();
    if (overlap.compareBoundaryPoints(Range.START_TO_START, bounds) < 0)
      overlap.setStart(bounds.startContainer, bounds.startOffset);
    if (overlap.compareBoundaryPoints(Range.END_TO_END, bounds) > 0)
      overlap.setEnd(bounds.endContainer, bounds.endOffset);
    return overlap.collapsed ? null : overlap;
  } catch {
    return null;
  }
}

const withoutSpace = (text: string) => text.replace(/\s/gu, '');
const BLOCK = /^(?:P|DIV|LI|UL|OL|BLOCKQUOTE|H[1-6]|PRE|TABLE|TR|TD|TH|SECTION|ARTICLE|DL|DT|DD)$/u;

/** Preserve semantic block boundaries without inline-flex's synthetic selection newlines. */
function readableDom(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element && node.tagName === 'BR') return '\n';
  const text = Array.from(node.childNodes, readableDom).join('');
  return node instanceof Element && BLOCK.test(node.tagName) ? `\n${text}\n` : text;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function labelReplacement(range: Range, label: Element, characters: number[]): Replacement | null | undefined {
  const overlap = clippedRangeWithin(range, label);
  const original = label.getAttribute('data-quote-source-text');
  if (!overlap || !original) return null;
  const part = overlap.toString();
  if (withoutSpace(part) !== withoutSpace(label.textContent ?? ''))
    return original.includes(part.trim()) ? undefined : null;
  const prefix = range.cloneRange();
  prefix.setEnd(overlap.startContainer, overlap.startOffset);
  const at = withoutSpace(prefix.toString()).length;
  const start = characters[at];
  const last = characters[at + withoutSpace(part).length - 1];
  return start === undefined || last === undefined ? null : { start, end: last + 1, text: original };
}

/**
 * Labels may abbreviate a source path or humanize a mention. Restore only their selected
 * characters, retaining semantic block separators without adding spaces around inline labels.
 * Partial labels are usable only when their literal characters also exist in the source.
 */
export function readableSelectionText(selection: Selection, root: Element): string | null {
  const range = selection.getRangeAt(0);
  const rendered = selection.toString();
  const selector = '[data-quote-source-text]';
  const candidates = [...(root.matches(selector) ? [root] : []), ...Array.from(root.querySelectorAll(selector))];
  const selected = candidates.filter((node) => clippedRangeWithin(range, node)?.toString().trim());
  // A fully selected atom owns its descendants. When only its filename/title is selected,
  // use that inner label instead of comparing it against state, metadata or operation text.
  const whole = new Set(
    selected.filter(
      (node) =>
        withoutSpace(clippedRangeWithin(range, node)?.toString() ?? '') === withoutSpace(node.textContent ?? ''),
    ),
  );
  const labels = selected.filter(
    (node) =>
      !selected.some(
        (other) =>
          other !== node && ((whole.has(other) && other.contains(node)) || (!whole.has(node) && node.contains(other))),
      ),
  );
  // Chromium also inserts layout newlines around plain inline code. Rebuild
  // block separators even when no source label needs restoring.
  const raw = readableDom(range.cloneContents());
  // Label replacement needs identical characters for offset alignment. Plain
  // viewers may render transformed text and retain their existing quote path.
  if (withoutSpace(raw) !== withoutSpace(rendered)) return labels.length ? null : rendered.trim();
  const characters: number[] = [];
  for (let index = 0; index < raw.length; index++) if (!/\s/u.test(raw[index] ?? '')) characters.push(index);
  const replacements: Replacement[] = [];
  for (const label of labels) {
    const replacement = labelReplacement(range, label, characters);
    if (replacement === null) return null;
    if (replacement) replacements.push(replacement);
  }
  let text = raw;
  for (const replacement of replacements.sort((left, right) => right.start - left.start))
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
  return text.trim();
}
