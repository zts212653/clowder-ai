import { expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectRuntimeInteractionHeading } from '../runtime-interaction-heading';
import { runtimeInteractionHeadingCopy } from '../runtime-interaction-heading.shell-copy';

it('requires the complete same-card binding and exact generated content before projecting a heading', () => {
  const message: Pick<ChatMessage, 'content' | 'extra'> = {
    content: '需要你回答：Keep 原文',
    extra: {
      runtimeInteractionCard: { version: 1, interactionId: 'original', blockId: 'bound-card', requestKind: 'question' },
      rich: {
        v: 1,
        blocks: [
          {
            id: 'bound-card',
            kind: 'card',
            v: 1,
            title: 'Keep 原文',
            meta: {
              kind: 'runtime_interaction',
              interactionId: 'original',
              interactionKind: 'question',
            },
          },
        ],
      },
    },
  };
  const variants = [
    { ...message, content: message.content + '\nAuthored addition' },
    { ...message, extra: { rich: message.extra!.rich } },
    {
      ...message,
      extra: {
        ...message.extra,
        runtimeInteractionCard: { ...message.extra!.runtimeInteractionCard!, blockId: 'other-card' },
      },
    },
    {
      ...message,
      extra: {
        ...message.extra,
        runtimeInteractionCard: { ...message.extra!.runtimeInteractionCard!, interactionId: 'other-request' },
      },
    },
    {
      ...message,
      extra: {
        ...message.extra,
        runtimeInteractionCard: { ...message.extra!.runtimeInteractionCard!, requestKind: 'approval' as const },
      },
    },
  ];
  for (const variant of variants) {
    const original = JSON.stringify(variant);
    expect(projectRuntimeInteractionHeading(variant, runtimeInteractionHeadingCopy.en)).toBe(variant.content);
    expect(JSON.stringify(variant)).toBe(original);
  }
});
