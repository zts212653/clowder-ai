import { afterEach, expect, it, vi } from 'vitest';
import { getDemoEvents, getDemoTeam } from '@/components/onboarding-demo/demo-story';
import { fetchThreadReplayEvents } from '@/lib/story-player/thread-replay-fetcher';
import { apiFetch } from '@/utils/api-client';
import { useReplayBindings } from '../useReplayBindings';
import { fixtureData, fixtureUi } from './chat-fixture';
import { act, cleanup, renderHook } from './hook-host';
import { useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/story-player/thread-replay-fetcher', () => ({ fetchThreadReplayEvents: vi.fn() }));
afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
});

it('plays the retained bundled collaboration script with the existing replay owner and does not write onboarding receipts', async () => {
  const data = fixtureData(),
    ui = fixtureUi();
  const { result } = renderHook(() => useOwnerProjection('replay', useReplayBindings(undefined, true), { data, ui }));
  await act(() => result.current.action('guideOpen', { language: 'en' }));
  expect(result.current.project().replayState).toMatchObject({ source: 'guide', at: 0, on: true, speed: '1' });
  expect(JSON.stringify(result.current.project().guide?.items)).toContain(getDemoEvents('en')[0].text);
  expect(result.current.project().guideActors['guide:architect']).toMatchObject({
    name: getDemoTeam('en').architect.name,
    avatarPath: '/avatars/opus.png',
  });
  await act(() => result.current.action('rpSeek', { v: '3' }));
  expect(result.current.project().guide).toMatchObject({
    preview: { message: { type: 'clowder-onboarding-stage', version: 1, stage: 'design', language: 'en' } },
  });
  expect(JSON.stringify(result.current.project().guide?.items)).toContain(getDemoEvents('en')[3].text);
  await act(() => result.current.action('rpSeek', { v: '8' }));
  expect(result.current.project().guide).toMatchObject({ preview: { message: { stage: 'final' } } });
  await act(() => result.current.action('guideOpen', { language: 'zh' }));
  expect(result.current.project().replayState).toMatchObject({ at: 0, on: true });
  await act(() => result.current.action('replayClose', {}));
  expect(result.current.project().replayState.on).toBe(false);
  expect(fetchThreadReplayEvents).not.toHaveBeenCalled();
  expect(apiFetch).not.toHaveBeenCalled();
});
