import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.apiFetch(...args) }));

import { useChangedFileCount } from '../use-changed-file-count';

function Probe({ worktreeId }: { worktreeId: string | null }) {
  return <output data-testid="count">{String(useChangedFileCount(worktreeId))}</output>;
}

describe('useChangedFileCount: a number only when the 变更 list would have that many', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.apiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const shown = () => container.querySelector('[data-testid="count"]')?.textContent;
  async function show(worktreeId: string | null) {
    await act(async () => root.render(<Probe worktreeId={worktreeId} />));
  }
  const reply = (body: unknown, ok = true) => mocks.apiFetch.mockResolvedValueOnce({ ok, json: async () => body });

  it('is unknown (null), not zero, until it has read one — and zero is a real answer', async () => {
    await show(null);
    expect(shown()).toBe('null');
    expect(mocks.apiFetch).not.toHaveBeenCalled();

    reply({ changedFiles: [], diff: '' });
    await show('wt-empty');
    expect(shown()).toBe('0');
  });

  it('stays unknown when the read fails or the answer is not the changed-files list', async () => {
    reply({}, false);
    await show('wt-a');
    expect(shown()).toBe('null');

    mocks.apiFetch.mockRejectedValueOnce(new Error('offline'));
    await show('wt-b');
    expect(shown()).toBe('null');

    reply({ changedFiles: 'three' });
    await show('wt-c');
    expect(shown()).toBe('null');
  });

  it('never shows one worktree’s number for another', async () => {
    reply({ changedFiles: [{}, {}, {}] });
    await show('wt-1');
    expect(shown()).toBe('3');

    mocks.apiFetch.mockRejectedValueOnce(new Error('offline'));
    await show('wt-2');
    expect(shown()).toBe('null');

    await show(null);
    expect(shown()).toBe('null');
  });
  describe('a number belongs to the read that produced it: coming back to a worktree starts a new, unknown read', () => {
    const readA = async () => {
      reply({ changedFiles: [{}, {}, {}] });
      await show('wt-A');
      expect(shown()).toBe('3');
    };
    const wentToB = async () => {
      // B's read never succeeds: nothing overwrites A's earlier snapshot.
      mocks.apiFetch.mockRejectedValueOnce(new Error('offline'));
      await show('wt-B');
      expect(shown()).toBe('null');
    };

    it('A → B → A: a re-read of A that is still pending shows nothing', async () => {
      await readA();
      await wentToB();
      mocks.apiFetch.mockReturnValueOnce(new Promise(() => undefined));
      await show('wt-A');
      expect(shown()).toBe('null');
    });

    it.each([
      ['offline', () => mocks.apiFetch.mockRejectedValueOnce(new Error('offline'))],
      ['refused (403)', () => reply({}, false)],
      ['not the changed-files list', () => reply({ changedFiles: 'three' })],
    ])('A → B → A: a re-read of A that is %s shows nothing', async (_name, arrange) => {
      await readA();
      await wentToB();
      arrange();
      await show('wt-A');
      expect(shown()).toBe('null');
    });

    it('A → none → A: no worktree in between does not keep the old number alive either', async () => {
      await readA();
      await show(null);
      expect(shown()).toBe('null');
      mocks.apiFetch.mockReturnValueOnce(new Promise(() => undefined));
      await show('wt-A');
      expect(shown()).toBe('null');
    });

    it('A → B → A: a fresh successful re-read replaces the old number', async () => {
      await readA();
      await wentToB();
      reply({ changedFiles: [{}, {}, {}, {}, {}] });
      await show('wt-A');
      expect(shown()).toBe('5');
    });

    it('an answer that arrives after its read was abandoned is never stored for later', async () => {
      let late: (value: unknown) => void = () => undefined;
      mocks.apiFetch.mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
      await show('wt-A');
      mocks.apiFetch.mockReturnValueOnce(new Promise(() => undefined));
      await show('wt-B');
      await act(async () => late({ ok: true, json: async () => ({ changedFiles: [{}, {}] }) }));
      expect(shown()).toBe('null');
      mocks.apiFetch.mockReturnValueOnce(new Promise(() => undefined));
      await show('wt-A');
      expect(shown()).toBe('null');
    });
  });
});
