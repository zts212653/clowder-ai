import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFirstRealMessageRetry } from '../useFirstRealMessageRetry';

function Harness({ onRetry }: { onRetry: () => void }) {
  const [retryKey, setRetryKey] = useState(0);
  useFirstRealMessageRetry({
    enabled: true,
    retryKey,
    onRetry: () => {
      onRetry();
      setRetryKey((value) => value + 1);
    },
    delayMs: 2000,
  });
  return <button type="button" onClick={() => setRetryKey((value) => value + 1)} data-testid="retry" />;
}

describe('useFirstRealMessageRetry', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('retries after a failed reconciliation without another message event', () => {
    const retry = vi.fn();
    act(() => {
      root = createRoot(container);
      root.render(<Harness onRetry={retry} />);
    });
    expect(retry).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1999));
    expect(retry).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(retry).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2000));
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('resets the retry timer when a manual retry key changes', () => {
    const retry = vi.fn();
    act(() => {
      root = createRoot(container);
      root.render(<Harness onRetry={retry} />);
    });
    act(() => vi.advanceTimersByTime(1000));
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="retry"]')?.click());
    act(() => vi.advanceTimersByTime(1000));
    expect(retry).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
