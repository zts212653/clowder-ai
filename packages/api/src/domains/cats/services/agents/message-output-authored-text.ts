import { normalizeJsonUnicode } from '../../../../utils/json-unicode.js';
import type { TextSourcePart } from '../text-provenance.js';
import { messageOutputSeparator } from './message-output-materializer.js';

/** Shared by live completion and durable draft recovery: summaries stay literal and non-executable. */
export function projectAuthoredTextParts(parts: readonly TextSourcePart[], transform: (content: string) => string) {
  const groups: TextSourcePart[] = [];
  for (const part of parts) {
    const last = groups.at(-1);
    if (last && last.textSource === part.textSource) last.content += part.content;
    else groups.push({ ...part });
  }
  let content = '';
  let authoredContent = '';
  for (const part of groups) {
    if (part.textSource === 'provider_summary') {
      const summary = normalizeJsonUnicode(part.content);
      content += messageOutputSeparator(content, summary) + summary;
      // Removed summaries must not join authored fragments into a command.
      authoredContent += '\n\n';
    } else {
      const cleaned = transform(normalizeJsonUnicode(part.content));
      content += messageOutputSeparator(content, cleaned) + cleaned;
      authoredContent += cleaned;
    }
  }
  return { content: content.trimEnd(), authoredContent: authoredContent.trimEnd() };
}
