import { expect, it } from 'vitest';
import { gifThumbnailSource } from '../gif-thumbnail';
import { gifDisplayClock } from '../useGifPlayback';

it('reduces native card motion using disposable first-frame URLs while preserving ordinary and external sources', () => {
  expect(gifThumbnailSource('/uploads/original.gif', false)).toBe('/uploads/original.gif');
  expect(gifThumbnailSource('/uploads/original.gif', true)).toBe('/uploads/original.gif/gif-poster');
  expect(gifThumbnailSource('/uploads/legacy.png', true, 'image/gif')).toBe('/uploads/legacy.png/gif-poster');
  expect(gifThumbnailSource('/api/content-publications/work-one/media/2', true, 'image/gif')).toBe(
    '/api/content-publications/work-one/media/2?display=gif-poster',
  );
  expect(gifThumbnailSource('/uploads/original.svg', true)).toBe('/uploads/original.svg');
  expect(gifThumbnailSource('/api/workspace/file/raw?worktreeId=w&path=x.gif', true, 'image/gif')).toBe(
    '/api/workspace/file/raw?worktreeId=w&path=x.gif&display=gif-poster',
  );
  expect(gifThumbnailSource('https://external.example/uploads/x.gif', true)).toBe(
    'https://external.example/uploads/x.gif',
  );
});

it('preserves every nonzero GIF delay and bounds only the otherwise unplayable zero-delay step', () => {
  expect(gifDisplayClock({ frameCount: 3, frameDelaysMs: [0, 10, 40], durationMs: 50, loopCount: 0 })).toEqual({
    starts: [0, 20, 30],
    duration: 70,
  });
});
