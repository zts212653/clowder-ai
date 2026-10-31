import { findGeneratedTextConstructs, projectMarkdownReadableTextWithSourceMap } from '@cat-cafe/shared';
import { resolveReadableQuoteAnchor } from '../cats/services/context/message-bundle-quote-matching.js';
import {
  type WorkspaceContentDescriptionV1,
  type WorkspaceContentLocatorV1,
  type WorkspaceContentPrincipalV1,
  WorkspaceContentSourceError,
  type WorkspaceTextQuoteResolutionV1,
} from './workspace-content-source-contract.js';
import { validateWorkspaceQuote } from './workspace-content-source-utils.js';
import { resolveWorkspaceTextQuote, workspaceTextAnchorAt } from './workspace-content-text-resolver.js';

export interface RenderedQuoteBatchInput {
  readonly principal: WorkspaceContentPrincipalV1;
  readonly locator: WorkspaceContentLocatorV1;
  readonly expectedRevision: string;
  readonly quotes: readonly string[];
}

/** The source owner supplies the stable read; the batch cannot invent a source or an authorization path. */
export async function resolveAuthorizedRenderedQuotes(
  input: RenderedQuoteBatchInput,
  readText: (input: RenderedQuoteBatchInput) => Promise<WorkspaceContentDescriptionV1 & { readonly text: string }>,
) {
  if (input.quotes.length > 1200) throw new WorkspaceContentSourceError('access_denied');
  const { text, ...source } = await readText(input);
  return {
    source,
    resolutions: resolveWorkspaceRenderedQuotes({
      text,
      quotes: input.quotes.map(validateWorkspaceQuote),
      markdown: isRenderedMarkdownPath(source.locator.path),
    }),
  };
}

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
  return resolveWorkspaceRenderedQuotes({ ...input, quotes: [input.quote] })[0];
}

/** One readable projection per stable batch; repeated text shares the same exact resolution. */
export function resolveWorkspaceRenderedQuotes(input: {
  readonly text: string;
  readonly quotes: readonly string[];
  readonly markdown: boolean;
}): WorkspaceTextQuoteResolutionV1[] {
  const generated = input.markdown && findGeneratedTextConstructs(input.text).length > 0;
  const projection = input.markdown && !generated ? projectMarkdownReadableTextWithSourceMap(input.text) : null;
  const cache = new Map<string, WorkspaceTextQuoteResolutionV1>();
  return input.quotes.map((quote) => {
    let result = cache.get(quote);
    if (!result) {
      result = generated
        ? { status: 'ambiguous' }
        : projection
          ? resolveProjectedQuote(input.text, quote, projection)
          : resolveWorkspaceTextQuote({ text: input.text, quote });
      cache.set(quote, result);
    }
    return result;
  });
}

function resolveProjectedQuote(
  text: string,
  quote: string,
  projection: ReturnType<typeof projectMarkdownReadableTextWithSourceMap>,
): WorkspaceTextQuoteResolutionV1 {
  // Offsets and matching both count UTF-16 units; a map of any other length cannot name a raw range.
  if (projection.sourceOffsets.length !== projection.text.length) return { status: 'orphaned' };
  const match = resolveReadableQuoteAnchor({ text: quote }, projection.text);
  if (match === 'ambiguous_quote') return { status: 'ambiguous' };
  if (match === 'quote_mismatch') return { status: 'orphaned' };
  const start = projection.sourceOffsets[match.selectionStart];
  const last = projection.sourceOffsets[match.selectionEnd - 1];
  if (start === null || start === undefined || last === null || last === undefined || last < start)
    return { status: 'orphaned' };
  return { status: 'attached', anchor: workspaceTextAnchorAt(text, start, last + 1) };
}
