// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useFirstProjectMistakeTipGate } from '../first-run-quest/useFirstProjectMistakeTipGate';

function Probe({
  phase,
  messageCount,
  hasActiveInvocation,
  threadId = 'thread-1',
}: {
  phase?: string;
  messageCount: number;
  hasActiveInvocation: boolean;
  threadId?: string;
}) {
  const ready = useFirstProjectMistakeTipGate({
    phase,
    messageCount,
    hasActiveInvocation,
    threadId,
  });

  return <div data-ready={ready ? 'yes' : 'no'} />;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useFirstProjectMistakeTipGate', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('does not arm the mistake tip merely because the phase already has history', async () => {
    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={2} hasActiveInvocation={false} />);
    });
    await flushEffects();

    expect(container.firstElementChild?.getAttribute('data-ready')).toBe('no');

    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={2} hasActiveInvocation={false} />);
    });
    await flushEffects();

    expect(container.firstElementChild?.getAttribute('data-ready')).toBe('no');
  });

  it('arms the mistake tip only after new phase-4 output finishes', async () => {
    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={2} hasActiveInvocation={true} />);
    });
    await flushEffects();

    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={3} hasActiveInvocation={true} />);
    });
    await flushEffects();
    expect(container.firstElementChild?.getAttribute('data-ready')).toBe('no');

    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={3} hasActiveInvocation={false} />);
    });
    await flushEffects();

    expect(container.firstElementChild?.getAttribute('data-ready')).toBe('yes');
  });

  it('resets the baseline when leaving phase-7-dev', async () => {
    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={2} hasActiveInvocation={true} />);
    });
    await flushEffects();

    await act(async () => {
      root.render(<Probe phase="phase-5-kickoff" messageCount={3} hasActiveInvocation={false} />);
    });
    await flushEffects();
    expect(container.firstElementChild?.getAttribute('data-ready')).toBe('no');

    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={3} hasActiveInvocation={false} />);
    });
    await flushEffects();
    expect(container.firstElementChild?.getAttribute('data-ready')).toBe('no');

    await act(async () => {
      root.render(<Probe phase="phase-7-dev" messageCount={4} hasActiveInvocation={false} />);
    });
    await flushEffects();
    expect(container.firstElementChild?.getAttribute('data-ready')).toBe('yes');
  });
});
