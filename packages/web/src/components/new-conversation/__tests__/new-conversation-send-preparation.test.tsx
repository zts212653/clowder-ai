import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { freshIntent } from '../new-conversation-hydration';
import { useNewConversationAdmissionSend } from '../use-new-conversation-admission-send';

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useNewConversationAdmissionSend>;
let options: Parameters<typeof useNewConversationAdmissionSend>[0];

function Host() {
  latest = useNewConversationAdmissionSend(options);
  return null;
}

async function waitForAct(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve());
    assertion();
  });
}

beforeEach(() => {
  options = {
    intentRef: { current: freshIntent('/isolated') },
    draftRef: { current: { text: 'draft', files: [], contextAttachments: [] } },
    saveSnapshot: vi.fn(async () => undefined),
    submit: vi.fn(async () => true),
    setPhasePreparing: vi.fn(),
    setPrepareFailed: vi.fn(),
    setPreparationCancelled: vi.fn(),
    setLocalSaveFailed: vi.fn(),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('cancels while waiting for the save and never submits on late completion', async () => {
  const gate = Promise.withResolvers<void>();
  let waiting = false;
  const wait = async () => {
    waiting = true;
    await gate.promise;
  };
  options.saveSnapshot = wait;
  act(() => root.render(<Host />));
  let sending = Promise.resolve(true);
  let result: boolean | undefined;
  try {
    act(() => {
      sending = latest.send({ content: 'draft' });
      void sending.then((value) => (result = value));
    });
    await waitForAct(() => expect(waiting).toBe(true));
    act(() => expect(latest.cancelPreparation()).toBe(true));
    await waitForAct(() => expect(result).toBe(false));
    expect(latest.preparing).toBe(false);
    expect(options.setPreparationCancelled).toHaveBeenCalledOnce();
    expect(options.setPrepareFailed).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      gate.resolve();
      await sending;
    });
  }
  expect(options.submit).not.toHaveBeenCalled();
});

it('does not let an old cancelled attempt unlock a later send', async () => {
  const oldSave = Promise.withResolvers<void>();
  const delivery = Promise.withResolvers<boolean>();
  options.saveSnapshot = vi
    .fn()
    .mockImplementationOnce(() => oldSave.promise)
    .mockResolvedValue(undefined);
  options.submit = vi.fn(() => delivery.promise);
  act(() => root.render(<Host />));
  let first = Promise.resolve(true);
  let second = Promise.resolve(false);
  try {
    act(() => {
      first = latest.send({ content: 'old request' });
    });
    act(() => latest.cancelPreparation());
    await act(async () => expect(await first).toBe(false));
    act(() => {
      second = latest.send({ content: 'new request' });
    });
    await waitForAct(() => expect(options.submit).toHaveBeenCalledOnce());
    await act(async () => {
      oldSave.resolve();
    });
    expect(latest.isAdmissionPending()).toBe(true);
    expect(latest.cancelPreparation()).toBe(false);
    expect(options.submit).toHaveBeenCalledWith({ content: 'new request' });
  } finally {
    await act(async () => {
      oldSave.resolve();
      delivery.resolve(true);
      await Promise.all([first, second]);
    });
  }
  expect(latest.isAdmissionPending()).toBe(false);
  expect(options.submit).toHaveBeenCalledOnce();
});
