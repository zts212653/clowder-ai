import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceToolbarButton } from '../WorkspaceToolbarButton';

describe('WorkspaceToolbarButton', () => {
  it.each([false, true])('keeps native button and disabled interaction semantics (disabled=%s)', (disabled) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onClick = vi.fn();
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      act(() =>
        root.render(
          <WorkspaceToolbarButton title="Copy" onClick={onClick} disabled={disabled}>
            Copy
          </WorkspaceToolbarButton>,
        ),
      );
      const button = host.querySelector('button');
      expect(button?.type).toBe('button');
      expect(button?.title).toBe('Copy');
      expect(button?.textContent).toBe('Copy');
      expect(button?.disabled).toBe(disabled);
      act(() => button?.click());
      expect(onClick).toHaveBeenCalledTimes(disabled ? 0 : 1);
    } finally {
      act(() => root.unmount());
      host.remove();
      environment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });
});
