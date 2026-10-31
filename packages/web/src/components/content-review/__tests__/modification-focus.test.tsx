import type { ContentModificationRecord } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearModificationFocus,
  focusModification,
  type ModificationFocus,
  type ModificationNavigation,
  modificationFocusStanding,
  usePendingModificationFocus,
} from '../modification-focus';

const record = (requestId: string) => ({ requestId }) as unknown as ContentModificationRecord;
const navigation = (revision: number, threadId = 'thread-1'): ModificationNavigation => ({ threadId, revision });

let latest: ModificationFocus | null;
let root: Root;
let host: HTMLElement;
function Probe() {
  latest = usePendingModificationFocus();
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearModificationFocus();
  latest = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearModificationFocus();
});

describe('modification focus (a receipt asked to see one candidate)', () => {
  it('reaches an entry that is already on screen and one that mounts afterwards', async () => {
    await act(async () => root.render(<Probe />));
    expect(latest).toBeNull();
    await act(async () => focusModification({ record: record('r1'), candidateRef: 'c1', navigation: navigation(4) }));
    expect(latest?.candidateRef).toBe('c1');
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<Probe />));
    expect(latest?.record.requestId).toBe('r1');
  });

  it('is cleared only by the entry that took that very ask, never a newer one', async () => {
    await act(async () => root.render(<Probe />));
    await act(async () => focusModification({ record: record('r1'), candidateRef: 'c1', navigation: navigation(4) }));
    const first = latest as ModificationFocus;
    await act(async () => focusModification({ record: record('r2'), candidateRef: 'c2', navigation: navigation(5) }));
    await act(async () => clearModificationFocus(first));
    expect(latest?.record.requestId).toBe('r2');
    await act(async () => clearModificationFocus(latest as ModificationFocus));
    expect(latest).toBeNull();
  });

  describe('standing: which navigation an ask belongs to, with no clock involved', () => {
    const ask: ModificationFocus = { record: record('r1'), navigation: navigation(4, 'thread-1') };

    it('is ours while that navigation is still the newest in its own conversation', () => {
      expect(modificationFocusStanding(ask, { threadId: 'thread-1', revision: 4 })).toBe('ours');
    });

    it('is superseded the moment a newer navigation replaces it, whichever conversation it was in', () => {
      expect(modificationFocusStanding(ask, { threadId: 'thread-1', revision: 5 })).toBe('superseded');
      expect(modificationFocusStanding(ask, { threadId: 'thread-2', revision: 5 })).toBe('superseded');
    });

    it('is elsewhere, not taken and not retired, while another conversation is current', () => {
      expect(modificationFocusStanding(ask, { threadId: 'thread-2', revision: 4 })).toBe('elsewhere');
      expect(modificationFocusStanding(ask, { threadId: null, revision: 4 })).toBe('elsewhere');
    });
  });
});
