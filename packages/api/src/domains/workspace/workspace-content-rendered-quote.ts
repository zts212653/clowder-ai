import { findGeneratedTextConstructs, projectMarkdownReadableTextWithSourceMap } from '@cat-cafe/shared';
import { resolveReadableQuoteAnchor } from '../cats/services/context/message-bundle-quote-matching.js';
import type { WorkspaceTextQuoteResolutionV1 } from './workspace-content-source-contract.js';
import { resolveWorkspaceTextQuote, workspaceTextAnchorAt } from './workspace-content-text-resolver.js';

/** The same rule the text landing uses to render a file as Markdown rather than as its raw text. */
export function isRenderedMarkdownPath(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

/**
 * A selection a person made on the rendered page, resolved to the raw source range behind it.
 *
 * Raw-rendered files (code, plain text) show their source, so the quote is matched exactly as before.
 * Markdown is matched in its rendered plane: the F294 readable projection (the renderer's own parser),
 * whitespace-normalized, accepted only when the quote occurs exactly once. The match's first and last
 * characters are then mapped back through the projection's source map. Nothing is guessed:
 * - a repeated quote is `ambiguous`;
 * - an end that has no single source character (a character reference, a separator) is `orphaned`;
 * - a file whose renderer generates text absent from the source (footnotes, math) is refused whole,
 *   because uniqueness cannot be proven against text the projection cannot see.
 * The anchor's `quote` is the raw source slice, so a later write checks the source, not the render.
 */
export function resolveWorkspaceRenderedQuote(input: {
  readonly text: string;
  readonly quote: string;
  readonly markdown: boolean;
}): WorkspaceTextQuoteResolutionV1 {
  if (!input.markdown) return resolveWorkspaceTextQuote({ text: input.text, quote: input.quote });
  if (findGeneratedTextConstructs(input.text).length > 0) return { status: 'ambiguous' };
  const projection = projectMarkdownReadableTextWithSourceMap(input.text);
  // Offsets and matching both count UTF-16 units; a map of any other length cannot name a raw range.
  if (projection.sourceOffsets.length !== projection.text.length) return { status: 'orphaned' };
  const match = resolveReadableQuoteAnchor({ text: input.quote }, projection.text);
  if (match === 'ambiguous_quote') return { status: 'ambiguous' };
  if (match === 'quote_mismatch') return { status: 'orphaned' };
  const start = projection.sourceOffsets[match.selectionStart];
  const last = projection.sourceOffsets[match.selectionEnd - 1];
  if (start === null || start === undefined || last === null || last === undefined || last < start)
    return { status: 'orphaned' };
  return { status: 'attached', anchor: workspaceTextAnchorAt(input.text, start, last + 1) };
}
