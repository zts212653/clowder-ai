import type { ConversationViewPreferenceSnapshot } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch }));

import {
  type ConversationViewPreferenceController,
  useConversationViewPreference,
} from '../useConversationViewPreference';

let latest: ConversationViewPreferenceController | null = null;

function Probe({ enabled }: { enabled: boolean }) {
  latest = useConversationViewPreference('thread-view', enabled);
  return <output data-loading={String(latest.loading)} data-mode={latest.snapshot.effective.mode} />;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useConversationViewPreference activation', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiFetch.mockReset();
    latest = null;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('does not read or write the preference while the v2 entry is disabled', async () => {
    await act(async () => root.render(<Probe enabled={false} />));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(latest).toMatchObject({ loading: false, saving: false, error: null });

    let saved = true;
    await act(async () => {
      saved = (await latest?.save({ mode: 'cat', catId: 'opus55' })) ?? true;
    });
    expect(saved).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('loads once when enabled and exposes the confirmed server snapshot', async () => {
    const snapshot: ConversationViewPreferenceSnapshot = {
      stored: { mode: 'cat', catId: 'opus55' },
      effective: { mode: 'cat', catId: 'opus55' },
      source: 'thread',
    };
    apiFetch.mockResolvedValue(Response.json(snapshot));

    await act(async () => root.render(<Probe enabled />));
    await settle();

    expect(apiFetch).toHaveBeenCalledOnce();
    expect(latest?.snapshot).toEqual(snapshot);
    expect(latest?.loading).toBe(false);
  });

  it('notifies a reading owner before a confirmed snapshot changes the visible view', async () => {
    const group: ConversationViewPreferenceSnapshot = {
      stored: null,
      effective: { mode: 'group' },
      source: 'product',
    };
    const cat: ConversationViewPreferenceSnapshot = {
      stored: { mode: 'cat', catId: 'opus55' },
      effective: { mode: 'cat', catId: 'opus55' },
      source: 'thread',
    };
    apiFetch.mockResolvedValueOnce(Response.json(group)).mockResolvedValueOnce(Response.json(cat));
    await act(async () => root.render(<Probe enabled />));
    await settle();

    const observations: Array<{ previous: string; next: string; visibleDuringCallback: string }> = [];
    const unsubscribe = latest?.subscribeBeforeCommit((previous, next) => {
      observations.push({
        previous: previous.effective.mode,
        next: next.effective.mode,
        visibleDuringCallback: latest?.snapshot.effective.mode ?? 'missing',
      });
    });
    await act(async () => {
      await latest?.save({ mode: 'cat', catId: 'opus55' });
    });

    expect(observations).toEqual([{ previous: 'group', next: 'cat', visibleDuringCallback: 'group' }]);
    expect(latest?.snapshot).toEqual(cat);
    unsubscribe?.();
  });
});
