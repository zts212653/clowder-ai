import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CatEyeIndicator, HUDActions } from '../guide-overlay-parts';

Object.assign(globalThis as Record<string, unknown>, { React });

const noop = () => {};

describe('HUDActions', () => {
  it('shows skip button when canSkip is true', () => {
    const html = renderToStaticMarkup(
      <HUDActions
        onPrev={noop}
        onNext={noop}
        onSkip={noop}
        onExit={noop}
        hasPrev={false}
        hasNext={true}
        isComplete={false}
        canSkip={true}
      />,
    );
    expect(html).toContain('跳过');
  });

  it('hides skip button when canSkip is false', () => {
    const html = renderToStaticMarkup(
      <HUDActions
        onPrev={noop}
        onNext={noop}
        onSkip={noop}
        onExit={noop}
        hasPrev={false}
        hasNext={true}
        isComplete={false}
        canSkip={false}
      />,
    );
    expect(html).not.toContain('跳过');
  });

  it('shows prev button when hasPrev is true', () => {
    const html = renderToStaticMarkup(
      <HUDActions
        onPrev={noop}
        onNext={noop}
        onSkip={noop}
        onExit={noop}
        hasPrev={true}
        hasNext={true}
        isComplete={false}
        canSkip={true}
      />,
    );
    expect(html).toContain('上一步');
  });

  it('hides prev button when hasPrev is false', () => {
    const html = renderToStaticMarkup(
      <HUDActions
        onPrev={noop}
        onNext={noop}
        onSkip={noop}
        onExit={noop}
        hasPrev={false}
        hasNext={true}
        isComplete={false}
        canSkip={true}
      />,
    );
    expect(html).not.toContain('上一步');
  });

  it('shows complete button when isComplete', () => {
    const html = renderToStaticMarkup(
      <HUDActions
        onPrev={noop}
        onNext={noop}
        onSkip={noop}
        onExit={noop}
        hasPrev={false}
        hasNext={false}
        isComplete={true}
        canSkip={true}
      />,
    );
    expect(html).toContain('完成');
    expect(html).not.toContain('下一步');
  });

  it('always shows exit button', () => {
    const html = renderToStaticMarkup(
      <HUDActions
        onPrev={noop}
        onNext={noop}
        onSkip={noop}
        onExit={noop}
        hasPrev={false}
        hasNext={false}
        isComplete={false}
        canSkip={false}
      />,
    );
    expect(html).toContain('退出');
  });
});

describe('CatEyeIndicator', () => {
  it('renders active state label', () => {
    const html = renderToStaticMarkup(<CatEyeIndicator state="active" />);
    expect(html).toContain('观察中');
  });

  it('renders locating state label', () => {
    const html = renderToStaticMarkup(<CatEyeIndicator state="locating" />);
    expect(html).toContain('定位中');
  });

  it('renders complete state label', () => {
    const html = renderToStaticMarkup(<CatEyeIndicator state="complete" />);
    expect(html).toContain('完成');
  });
});
