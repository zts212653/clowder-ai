import { readProfileOpeningReference } from '@cat-cafe/shared/profile-opening-reference';

export { readProfileOpeningReference } from '@cat-cafe/shared/profile-opening-reference';

export function renderProfileOpeningReference(reference: NonNullable<ReturnType<typeof readProfileOpeningReference>>) {
  return [
    `参考 · 截至 ${reference.asOf}`,
    '以下是已选择的历史记录，不代表当前授权；能力判断只属于注明的模型。',
    ...reference.excerpts.map((item) =>
      [
        `- ${item.kind === 'relationship' ? '陪伴与关系' : `历史能力判断（具体模型：${item.model}）`}：${JSON.stringify(item.text)}`,
        `  原消息：thread:${item.source.threadId}#${item.source.messageId}`,
      ].join('\n'),
    ),
  ].join('\n');
}
