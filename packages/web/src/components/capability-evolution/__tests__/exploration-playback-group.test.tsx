import { evolutionExplorationReviewV1Schema } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { explorationFixture, source } from '../../../../../api/test/capability-evolution-exploration.helper.mjs';
import { ExplorationMedia } from '../exploration/ExplorationMedia';
import { ExplorationPlaybackGroup } from '../exploration/ExplorationPlaybackGroup';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function render(enabled = true, suffix = '', count: 2 | 4 = 2) {
  const data = evolutionExplorationReviewV1Schema.parse(explorationFixture({ withDetail: true }));
  if (data.status !== 'resolved' || data.details[0]?.status !== 'resolved') throw Error('unresolved fixture');
  const record = data.details[0]!.records[0]!;
  await act(async () =>
    root.render(
      <ExplorationPlaybackGroup key={suffix} enabled={enabled} expectedPlayers={count}>
        {(count === 4 ? ['v1', 'v2', 'v3', 'v4'] : ['left', 'right']).map((side) => (
          <ExplorationMedia
            key={side}
            programId={data.programRef.ownerStateRef}
            onRetry={() => {}}
            record={{
              ...record,
              recordRef: source(side + suffix),
              experimentRef: source(`${side}-run${suffix}`),
              media: [
                {
                  mediaRef: source(`${side}-video${suffix}`, 'a'.repeat(64)),
                  kind: 'video',
                  contentType: 'video/mp4',
                  provenance: 'original',
                  label: `${side} replay`,
                  sourceRecordRef: record.evidenceRef,
                },
              ],
            }}
          />
        ))}
      </ExplorationPlaybackGroup>,
    ),
  );
}
it('waits for all four same-scene originals and pauses the complete group together', async () => {
  await render(true, '', 4);
  await act(async () => button('四段同步播放').click());
  const videos = [...host.querySelectorAll('video')];
  expect(videos).toHaveLength(4);
  for (const video of videos) Object.defineProperty(video, 'readyState', { value: 1, configurable: true });
  await act(async () =>
    videos.slice(0, 3).forEach((video) => video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }))),
  );
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  await act(async () => videos[3]!.dispatchEvent(new Event('loadedmetadata', { bubbles: true })));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(4);
  await act(async () => button('暂停联播').click());
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(4);
});
function button(label: string) {
  const result = [...host.querySelectorAll('button')].find((x) => x.textContent === label);
  expect(result).toBeDefined();
  return result!;
}
it('opens both exact originals, waits for both metadata, then plays and seeks them together', async () => {
  await render();
  await act(async () => button('两段同步播放').click());
  const videos = [...host.querySelectorAll('video')];
  expect(videos).toHaveLength(2);
  expect(videos[0]?.src).toContain('left-run');
  expect(videos[1]?.src).toContain('right-run');
  Object.defineProperty(videos[0], 'readyState', { value: 1, configurable: true });
  await act(async () => videos[0]!.dispatchEvent(new Event('loadedmetadata', { bubbles: true })));
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  Object.defineProperty(videos[1], 'readyState', { value: 1, configurable: true });
  await act(async () => videos[1]!.dispatchEvent(new Event('loadedmetadata', { bubbles: true })));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  videos[0]!.currentTime = 3;
  await act(async () => videos[0]!.dispatchEvent(new Event('seeking', { bubbles: true })));
  expect(videos[1]!.currentTime).toBe(3);
  await act(async () => button('暂停联播').click());
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(2);
});
it('does not let a delayed programmatic seek pull the leading original backwards', async () => {
  await render();
  await act(async () => button('两段同步播放').click());
  const videos = [...host.querySelectorAll('video')];
  for (const video of videos) Object.defineProperty(video, 'readyState', { value: 1, configurable: true });
  await act(async () => videos.forEach((video) => video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }))));
  videos[0]!.currentTime = 9.8;
  await act(async () => videos[0]!.dispatchEvent(new Event('seeking', { bubbles: true })));
  expect(videos[1]!.currentTime).toBe(9.8);
  videos[0]!.currentTime = 9.97;
  await act(async () => videos[1]!.dispatchEvent(new Event('seeking', { bubbles: true })));
  expect(videos[0]!.currentTime).toBe(9.97);
  // A user overrides the pending follower seek; the new explicit time still drives the group.
  videos[1]!.currentTime = 5;
  await act(async () => videos[1]!.dispatchEvent(new Event('seeking', { bubbles: true })));
  expect(videos[0]!.currentTime).toBe(5);
});
it('replacing the evidence cancels linked playback and never starts the new records automatically', async () => {
  await render();
  await act(async () => button('两段同步播放').click());
  const videos = [...host.querySelectorAll('video')];
  for (const video of videos) Object.defineProperty(video, 'readyState', { value: 1, configurable: true });
  await act(async () => videos.forEach((video) => video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }))));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  await render(true, '-new');
  expect(host.querySelectorAll('video')).toHaveLength(0);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(2);
});
it('keeps classic originals individually playable without adding linked controls', async () => {
  await render(false);
  expect(host.textContent).not.toContain('两段同步播放');
  await act(async () => button('在原地打开回放').click());
  expect(host.querySelectorAll('video')).toHaveLength(1);
});
it('does not let a cancelled play promise finish a newer request or start the pair twice', async () => {
  const completions: Array<() => void> = [];
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(
    () => new Promise<void>((resolve) => completions.push(resolve)),
  );
  await render();
  await act(async () => button('两段同步播放').click());
  const videos = [...host.querySelectorAll('video')];
  for (const video of videos) Object.defineProperty(video, 'readyState', { value: 1, configurable: true });
  await act(async () => videos.forEach((video) => video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }))));
  expect(completions).toHaveLength(2);
  await act(async () => button('取消联播').click());
  await act(async () => button('两段同步播放').click());
  expect(completions).toHaveLength(4);
  await act(async () => completions.slice(0, 2).forEach((finish) => finish()));
  expect(host.textContent).toContain('正在读取两段原始录像');
  expect(host.textContent).not.toContain('暂停联播');
  await act(async () => videos[0]!.dispatchEvent(new Event('loadedmetadata', { bubbles: true })));
  expect(completions).toHaveLength(4);
  await act(async () => completions.slice(2).forEach((finish) => finish()));
  expect(host.textContent).toContain('暂停联播');
});
it('retries the failed original and waits for its replacement metadata before linked playback', async () => {
  await render();
  await act(async () => button('两段同步播放').click());
  const original = [...host.querySelectorAll('video')];
  Object.defineProperty(original[0], 'readyState', { value: 1, configurable: true });
  await act(async () => original[0]!.dispatchEvent(new Event('loadedmetadata', { bubbles: true })));
  await act(async () => original[1]!.dispatchEvent(new Event('error', { bubbles: true })));
  expect(host.textContent).toContain('联播暂未开始');
  await act(async () => button('两段同步播放').click());
  expect(host.querySelectorAll('video')).toHaveLength(2);
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  const replacement = [...host.querySelectorAll('video')][1]!;
  expect(replacement).not.toBe(original[1]);
  expect(replacement.src).toContain('right-run');
  Object.defineProperty(replacement, 'readyState', { value: 1, configurable: true });
  await act(async () => replacement.dispatchEvent(new Event('loadedmetadata', { bubbles: true })));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
});
