import { findInlineEventHandlerAttributes } from '@cat-cafe/shared';
import type { ToolResult } from './file-tools.js';

/**
 * #1640: Author feedback for html_widget publication. Inline `on*` attributes are
 * stripped by the widget sanitizer, so the button renders but never reacts. Names
 * only — attribute values (the handler code) are never echoed.
 */
export function htmlWidgetInlineHandlerHint(block: { kind: string; html?: unknown }): string | undefined {
  if (block.kind !== 'html_widget' || typeof block.html !== 'string') return undefined;
  const names = findInlineEventHandlerAttributes(block.html);
  if (names.length === 0) return undefined;
  return (
    `\n\n⚠️ HTML_WIDGET INLINE EVENT HANDLERS: detected inline event attribute(s) ${names.join(', ')}. ` +
    'The widget sanitizer strips inline on* attributes when rendering, so these interactions will not fire and no error is shown. ' +
    "Bind events inside <script> with addEventListener (e.g. el.addEventListener('click', …)) and republish."
  );
}

/** Syntax-only preflight: valid base64 can still contain damaged image bytes. */
export function htmlWidgetPublishHint(block: { kind: string; html?: unknown }): string | undefined {
  const hints = [htmlWidgetInlineHandlerHint(block)];
  if (block.kind === 'html_widget' && typeof block.html === 'string') {
    let malformed = 0;
    for (const match of block.html.matchAll(/(["'`])data:image\/[a-z0-9.+-]+;base64,([^"'`<>)]*)\1/gi)) {
      const payload = match[2]?.trim();
      if (!payload || payload.includes('\\') || (match[1] === '`' && payload.includes('${'))) continue; // Dynamic/escaped script sources are not statically decidable.
      try {
        atob(payload);
      } catch {
        malformed++;
      }
    }
    if (malformed > 0) {
      hints.push(
        `\n\n⚠️ HTML_WIDGET IMAGE DATA: ${malformed} malformed base64 image(s) detected. ` +
          'The browser cannot decode these sources. Read image bytes from the original file programmatically; ' +
          'do not transcribe base64. Correct the payload and republish.',
      );
    }
  }
  return hints.filter(Boolean).join('') || undefined;
}

export function appendHintToSuccess(result: ToolResult, hint: string | undefined): ToolResult {
  if (!hint || result.isError) return result;
  const existingText = result.content[0]?.text ?? '';
  return { ...result, content: [{ type: 'text', text: existingText + hint }, ...result.content.slice(1)] };
}
