import type { ContentCapability, ContentLandingCapabilities, ContentReviewView } from './content-review-contract';

/** These are owner facts, not an entrance-specific feature allowlist. */
export function contentReviewCapabilities(view: ContentReviewView): ContentLandingCapabilities {
  const source = view.review.source;
  const medium = source.kind === 'text' ? 'text' : source.media.kind;
  const writable: ContentCapability =
    view.sourceState === 'unavailable'
      ? { state: 'unavailable', reason: '原内容当前不可读取。' }
      : view.historyReadOnly
        ? { state: 'read_only', reason: '这是历史版本，讨论和标记留在原版。' }
        : view.sourceState === 'changed'
          ? { state: 'read_only', reason: '原内容已变化，请核对当前版本。' }
          : view.canWrite
            ? { state: 'available' }
            : { state: 'read_only', reason: '当前来源只读。' };
  return {
    annotate: writable,
    reply:
      view.sourceState === 'current' && (view.canReply ?? view.canWrite)
        ? { state: 'available' }
        : { state: 'read_only', reason: '当前来源不允许追加讨论。' },
    markup: medium === 'text' ? { state: 'unavailable', reason: '文字内容使用选区批注。' } : writable,
    requestModification: { ...writable, medium },
    versions:
      source.kind === 'publication'
        ? { state: 'available' }
        : {
            state: 'unavailable',
            reason:
              source.kind === 'evolution'
                ? '这是归档原件，派生作品在修改记录中查看。'
                : '这里是原文件当前版本，修改结果在委托记录中查看。',
          },
    decide: { state: 'unavailable', reason: '未选择审阅裁决上下文。' },
    historyReadOnly: view.historyReadOnly === true,
  };
}
