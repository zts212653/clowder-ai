// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BootcampGuideOverlay } from '../first-run-quest/BootcampGuideOverlay';

describe('BootcampGuideOverlay', () => {
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

  it('keeps the intro full-screen overlay and input tip for phase-1 before any messages', async () => {
    await act(async () => {
      root.render(<BootcampGuideOverlay phase="phase-1-intro" catName="布偶猫" hasMessages={false} />);
    });

    expect(container.textContent).toContain('在下方输入框输入 @布偶猫 你好  开始训练营');
    expect(container.querySelector('.fixed.inset-0')).not.toBeNull();
  });

  it('renders lifecycle tip for phase-7-dev when there are messages', async () => {
    await act(async () => {
      root.render(<BootcampGuideOverlay phase="phase-7-dev" catName="布偶猫" hasMessages />);
    });

    expect(container.textContent).toContain('猫猫正在开发');
  });

  it('returns null for phase-7.5 (guide engine handles it)', async () => {
    await act(async () => {
      root.render(<BootcampGuideOverlay phase="phase-7.5-add-teammate" catName="布偶猫" hasMessages />);
    });

    expect(container.innerHTML).toBe('');
  });

  it('returns null for early phases when there are messages', async () => {
    await act(async () => {
      root.render(<BootcampGuideOverlay phase="phase-1-intro" catName="布偶猫" hasMessages />);
    });

    expect(container.innerHTML).toBe('');
  });
});
