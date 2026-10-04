import type { MessagePublicationChoice } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { choiceIntro, namedChoices } from '../message-publication-choices';

const choice = (mediaType: 'image/png' | 'video/mp4', taskTitle?: string): MessagePublicationChoice =>
  ({
    asset: {
      contentRef: `prepared-media:${(taskTitle ? 'b' : 'a').repeat(64)}`,
      ownerRevision: 1,
      blobDigest: `sha256:${'c'.repeat(64)}`,
      mediaType,
      media:
        mediaType === 'image/png'
          ? { kind: 'image', width: 2, height: 2 }
          : { kind: 'video', width: 2, height: 2, durationMs: 1000 },
      ownerReceiptRef: 'receipt',
      sourcePublication: { artifactRef: '/uploads/a', sourceRef: 'message:t:m', revision: '1' },
    },
    title: 'a',
    threadTitle: '一起画画',
    match: 'exact',
    ...(taskTitle ? { taskTitle, targetName: '缅因猫' } : {}),
  }) as MessagePublicationChoice;

it('names the direct discussion after the kind of work (real page 2026-09-24: a video read "这张图")', () => {
  const video = [choice('video/mp4'), choice('video/mp4', '把视频转成灰度')];
  expect(namedChoices(video, {}).map((item) => item.heading)).toContain('直接在这段视频上讨论（独立于任务审阅）');
  expect(choiceIntro(video)).toMatch(/^这段视频已关联猫的任务审阅/);

  const image = [choice('image/png'), choice('image/png', '转灰度')];
  expect(namedChoices(image, {}).map((item) => item.heading)).toContain('直接在这张图上讨论（独立于任务审阅）');
  expect(choiceIntro(image)).toMatch(/^这张图已关联猫的任务审阅/);
});
