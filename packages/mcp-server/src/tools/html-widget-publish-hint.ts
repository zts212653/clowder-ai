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

export function appendHintToSuccess(result: ToolResult, hint: string | undefined): ToolResult {
  if (!hint || result.isError) return result;
  const existingText = result.content[0]?.text ?? '';
  return { ...result, content: [{ type: 'text', text: existingText + hint }, ...result.content.slice(1)] };
}
