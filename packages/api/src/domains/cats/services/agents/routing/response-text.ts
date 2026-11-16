import type { RichBlock } from '@cat-cafe/shared';
import {
  projectConciergeStoredContent,
  stripTriagePlanMarkers,
} from '../../../../concierge/concierge-reply-validator.js';
import type { RoutingMessageOutputProjection } from './message-output-projection.js';
import { extractRichFromText } from './rich-block-extract.js';
import { sanitizeInjectedContent } from './route-helpers.js';

/** One visible body, with an authored-only view for executable text grammars. */
export function prepareResponseText(
  text: string,
  projection: Pick<RoutingMessageOutputProjection, 'projectAuthoredText'> | undefined,
  concierge: boolean,
) {
  const blocks: RichBlock[] = [];
  const clean = (content: string) => extractRichFromText(sanitizeInjectedContent(content));
  const collect = (content: string) => {
    const result = clean(content);
    blocks.push(...result.blocks);
    return result.cleanText;
  };
  const body =
    projection?.projectAuthoredText(collect) ??
    (() => {
      const content = collect(text);
      return { content, authoredContent: content };
    })();
  const conciergeActionSourceContent = concierge && body.authoredContent ? body.authoredContent : undefined;
  if (!conciergeActionSourceContent) return { ...body, blocks, conciergeActionSourceContent };
  const project = (content: string) => projectConciergeStoredContent(stripTriagePlanMarkers(clean(content).cleanText));
  return {
    content:
      projection?.projectAuthoredText(project).content ??
      projectConciergeStoredContent(stripTriagePlanMarkers(body.content)),
    authoredContent: stripTriagePlanMarkers(body.authoredContent),
    blocks,
    conciergeActionSourceContent,
  };
}
