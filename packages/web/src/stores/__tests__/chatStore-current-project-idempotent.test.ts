import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../chatStore';

describe('chatStore setCurrentProject idempotent guard', () => {
  beforeEach(() => {
    useChatStore.setState({ currentProjectPath: 'default' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the same store snapshot when projectPath is unchanged', () => {
    const { setCurrentProject } = useChatStore.getState();
    const before = useChatStore.getState();
    const listener = vi.fn();
    const unsubscribe = useChatStore.subscribe(listener);

    setCurrentProject('default');

    const after = useChatStore.getState();
    expect(after).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('updates the store when projectPath actually changes', () => {
    const { setCurrentProject } = useChatStore.getState();
    const before = useChatStore.getState();

    setCurrentProject('/tmp/foreign-repo');

    const after = useChatStore.getState();
    expect(after.currentProjectPath).toBe('/tmp/foreign-repo');
    expect(after).not.toBe(before);
  });
});
