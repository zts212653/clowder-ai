/** Connector id for Host content-review returns addressed to a cat. */
export const HOST_CONTENT_REVIEW_CONNECTOR = 'content-review';

/**
 * Host content-review returns are written for the cat (coordinates + tool steps).
 * The human-facing summary is the bracketed first-line title, e.g.
 * "[Host 作品修改请求：原任务续办] …" → "作品修改请求：原任务续办".
 */
export function hostReturnHeadline(content: string): string {
  const [firstLine = ''] = content.split('\n', 1);
  const bracketed = /^\[Host\s*([^\]]+)\]/.exec(firstLine);
  return bracketed?.[1]?.trim() || '已交回原任务';
}
