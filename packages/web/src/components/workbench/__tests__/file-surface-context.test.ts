import { describe, expect, it } from 'vitest';
import { createFileSurface } from '../real-surface-adapters';

describe('file surface header context', () => {
  it('shows the file path, not the internal workspace root id, next to the title', () => {
    const rootId = 'f063_root_v1_71b6cbbdd2bed7fe4c02a224a665d0f361f94a7896e5fa1767a0d35f7a60be51';
    const surface = createFileSurface({ worktreeId: rootId, path: 'docs/menu.md' });

    expect(surface.title).toBe('menu.md');
    expect(surface.context).toBe('docs/menu.md');
    expect(surface.context).not.toContain(rootId);
    // Identity stays on the typed refs, where it belongs.
    expect(surface.objectRef.id).toBe(rootId);
  });
});
