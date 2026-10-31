import { act, StrictMode, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PendingComposerSelection, usePendingComposerSelection } from '../use-pending-composer-selection';

const text = 'ABCDEFGHIJKL\n@original-owner';
const intent = (focus = false): PendingComposerSelection => ({ text, start: 3, end: 8, direction: 'backward', focus });
let root: Root, node: HTMLDivElement, outside: HTMLButtonElement;
let frames: Map<number, FrameRequestCallback>, serial: number;
function Composer({
  request,
  value = text,
  count = 1,
  reset = true,
  unrelatedCommit = false,
}: {
  request?: PendingComposerSelection;
  value?: string;
  count?: number;
  reset?: boolean;
  unrelatedCommit?: boolean;
}) {
  const [, setCommit] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pending = useRef(request ?? null),
    previous = useRef(request);
  if (previous.current !== request) {
    previous.current = request;
    pending.current = request ?? null;
  }
  usePendingComposerSelection(value, textarea, pending, count);
  // Observed native Chromium reset: same unfocused field is cleared after the synchronous layout restore.
  // biome-ignore lint/correctness/useExhaustiveDependencies: emulate the observed native reset on each value/attachment commit.
  useLayoutEffect(() => {
    if (reset) textarea.current?.setSelectionRange(0, 0, 'forward');
    if (unrelatedCommit) setCommit((version) => version + 1);
  }, [reset, value, count, unrelatedCommit]);
  return <textarea ref={textarea} value={value} onChange={() => {}} />;
}
const range = (input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection];
function input() {
  const field = node.querySelector('textarea');
  if (!field) throw new Error('Original composer absent');
  return field;
}
async function flushRestore() {
  const callbacks = [...frames.values()];
  frames.clear();
  await act(async () => {
    for (const callback of callbacks) callback(1);
    vi.runOnlyPendingTimers();
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  frames = new Map();
  serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
  outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  outside.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])('keeps a focused recall restore through an unrelated commit, StrictMode=%s', async (strict) => {
  vi.useFakeTimers();
  const child = <Composer request={{ ...intent(), focus: true }} unrelatedCommit />;
  await act(async () => root.render(strict ? <StrictMode>{child}</StrictMode> : child));
  await act(async () => vi.runOnlyPendingTimers());
  expect(range(input())).toEqual([3, 8, 'backward']);
  expect(document.activeElement).toBe(input());
});

describe.each([false, true])('selection focus=%s', (focus) => {
  it.each([
    false,
    true,
  ])('keeps a pending selection after the browser commit, including StrictMode=%s', async (strict) => {
    const child = <Composer request={intent(focus)} />;
    await act(async () => root.render(strict ? <StrictMode>{child}</StrictMode> : child));
    const field = input();
    expect(range(field)).toEqual([0, 0, 'forward']);
    await flushRestore();
    expect(range(field)).toEqual([3, 8, 'backward']);
    expect(document.activeElement).toBe(focus ? field : outside);
    expect(frames.size).toBe(0);
  });

  it.each([
    'keydown',
    'pointerdown',
    'input',
    'focusin',
    'compositionstart',
  ])('lets a later native %s operation win', async (kind) => {
    await act(async () => root.render(<Composer request={intent(focus)} />));
    const field = input();
    field.dispatchEvent(new Event(kind, { bubbles: true }));
    field.setSelectionRange(9, 11, 'forward');
    await flushRestore();
    expect(range(field)).toEqual([9, 11, 'forward']);
  });

  it('lets a newer intent on the same text own the next commit', async () => {
    await act(async () => root.render(<Composer request={intent(focus)} />));
    await act(async () => root.render(<Composer request={{ ...intent(focus), start: 5, end: 10 }} count={2} />));
    await flushRestore();
    expect(range(input())).toEqual([5, 10, 'backward']);
  });

  it('consumes a new explicit intent even when text and attachment count are unchanged', async () => {
    await act(async () => root.render(<Composer request={intent(focus)} />));
    await flushRestore();
    await act(async () => root.render(<Composer request={{ ...intent(focus), start: 5, end: 10 }} />));
    await flushRestore();
    expect(range(input())).toEqual([5, 10, 'backward']);
  });

  it('cancels a stale restore when text changes and does not revive it if the old text returns', async () => {
    const request = intent(focus);
    await act(async () => root.render(<Composer request={request} />));
    await act(async () => root.render(<Composer request={request} value="different words" />));
    await flushRestore();
    await act(async () => root.render(<Composer request={request} />));
    await flushRestore();
    expect(range(input())).toEqual([0, 0, 'forward']);
  });

  it('does not restore across a same-text textarea replacement or an unmount', async () => {
    await act(async () => root.render(<Composer key="original-thread" request={intent(focus)} />));
    const original = node.querySelector('textarea');
    await act(async () => root.render(<Composer key="other-thread" />));
    expect(node.querySelector('textarea')).not.toBe(original);
    await flushRestore();
    expect(range(input())).toEqual([0, 0, 'forward']);
    await act(async () => root.render(<Composer key="third-thread" request={intent(focus)} />));
    await act(async () => root.render(null));
    expect(frames.size).toBe(0);
  });
});
