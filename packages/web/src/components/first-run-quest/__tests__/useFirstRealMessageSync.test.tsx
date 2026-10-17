import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJourneyState } from '../onboarding-journey';
import { useFirstRealMessageSync } from '../useFirstRealMessageSync';

const threadId = 'thread-first-run';
const journey = createJourneyState();
journey.stage = 'ready';
journey.threadId = threadId;

const bootcampState = {
  v: 1 as const,
  phase: 'phase-1-intro' as const,
  journeyId: journey.journeyId,
  startedAt: 1,
};

let storeState: { threads: Array<{ id: string; bootcampState?: typeof bootcampState }> } = { threads: [] };

const mockApiFetch = vi.fn();

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(() => null, {
    getState: () => storeState,
    setState: (updater: (state: typeof storeState) => typeof storeState) => {
      storeState = updater(storeState);
    },
  }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function Harness({ hydrated, onSent }: { hydrated: boolean; onSent: () => void }) {
  const currentBootcampState = hydrated ? bootcampState : undefined;
  const [syncError, setSyncError] = useState(false);
  const [, setHintVisible] = useState(true);
  const { handleRealOnboardingMessage, requestRetry } = useFirstRealMessageSync({
    threadId,
    currentBootcampState,
    onboardingSyncError: syncError,
    setOnboardingSyncError: setSyncError,
    setShowOnboardingHint: setHintVisible,
  });

  return (
    <>
      <button
        type="button"
        data-testid="send"
        onClick={() => {
          onSent();
          handleRealOnboardingMessage(threadId);
        }}
      />
      <button type="button" data-testid="hydrate" onClick={() => undefined} />
      <button type="button" data-testid="retry" onClick={requestRetry} />
      <output data-testid="sync-error">{String(syncError)}</output>
    </>
  );
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useFirstRealMessageSync', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    storeState = { threads: [] };
    mockApiFetch.mockReset();
    localStorage.setItem('cat-cafe:onboarding-journey', JSON.stringify(journey));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('reconciles one sent message after hydration, failure, and automatic retry', async () => {
    let sentCount = 0;
    mockApiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bootcampState: { ...bootcampState, completedAt: 900 } }),
    });

    act(() => root.render(<Harness hydrated={false} onSent={() => (sentCount += 1)} />));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="send"]')?.click());
    expect(sentCount).toBe(1);
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(localStorage.getItem('cat-cafe:onboarding-first-real-message-pending')).toContain(threadId);

    storeState = { threads: [{ id: threadId, bootcampState }] };
    act(() => root.render(<Harness hydrated onSent={() => (sentCount += 1)} />));
    await flushPromises();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('cat-cafe:onboarding-journey')).toContain('"stage":"ready"');

    act(() => vi.advanceTimersByTime(1999));
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(sentCount).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    await flushPromises();

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(sentCount).toBe(1);
    expect(localStorage.getItem('cat-cafe:onboarding-first-real-message-pending')).toBeNull();
    expect(JSON.parse(localStorage.getItem('cat-cafe:onboarding-journey') ?? '{}')).toMatchObject({
      stage: 'complete',
      completedAt: 900,
    });
    expect(storeState.threads[0]?.bootcampState).toMatchObject({ completedAt: 900 });
  });

  it('restores a failed reconciliation after refresh without another message', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    localStorage.setItem(
      'cat-cafe:onboarding-first-real-message-pending',
      JSON.stringify({ journeyId: journey.journeyId, threadId }),
    );
    storeState = { threads: [{ id: threadId, bootcampState }] };

    act(() => root.render(<Harness hydrated onSent={() => undefined} />));
    await flushPromises();
    expect(mockApiFetch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(2000));
    await flushPromises();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('cat-cafe:onboarding-first-real-message-pending')).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    mockApiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ bootcampState: { ...bootcampState, completedAt: 901 } }),
    });
    act(() => root.render(<Harness hydrated onSent={() => undefined} />));
    act(() => vi.advanceTimersByTime(2000));
    await flushPromises();

    expect(mockApiFetch).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('cat-cafe:onboarding-first-real-message-pending')).toBeNull();
    expect(JSON.parse(localStorage.getItem('cat-cafe:onboarding-journey') ?? '{}')).toMatchObject({
      stage: 'complete',
      completedAt: 901,
    });
  });
});
