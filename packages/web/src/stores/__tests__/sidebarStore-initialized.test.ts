import { beforeEach, describe, expect, it } from 'vitest';
import { useSidebarStore } from '../sidebarStore';

describe('sidebarStore initialized flag', () => {
  beforeEach(() => {
    useSidebarStore.setState({ isOpen: false, initialized: false });
  });

  it('starts uninitialized, which is how "nothing has opened it yet" differs from "the user collapsed it"', () => {
    expect(useSidebarStore.getState().isOpen).toBe(false);
    expect(useSidebarStore.getState().initialized).toBe(false);
  });

  it('open, close and toggle each mark it initialized', () => {
    useSidebarStore.getState().open();
    expect(useSidebarStore.getState()).toMatchObject({ isOpen: true, initialized: true });

    useSidebarStore.setState({ isOpen: false, initialized: false });
    useSidebarStore.getState().close();
    expect(useSidebarStore.getState()).toMatchObject({ isOpen: false, initialized: true });

    useSidebarStore.setState({ isOpen: false, initialized: false });
    useSidebarStore.getState().toggle();
    expect(useSidebarStore.getState()).toMatchObject({ isOpen: true, initialized: true });
  });

  it('a collapse after opening stays initialized, so it reads as the user choosing it', () => {
    useSidebarStore.getState().open();
    useSidebarStore.getState().close();
    expect(useSidebarStore.getState()).toMatchObject({ isOpen: false, initialized: true });
  });
});
