/**
 * F252 Phase E PR E-4 — MultiCamStage + ThreadPanel Tests
 *
 * AC-E5: Layout rendering for 1/2/3/4 threads
 * AC-E3: Spotlight/dim CSS class assertions
 *
 * Uses renderToStaticMarkup (project convention — no @testing-library/react).
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MultiCamStage, type ThreadPanelConfig } from '../MultiCamStage';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePanel(threadId: string, mode: 'spotlight' | 'active' | 'dim', messageCount = 0): ThreadPanelConfig {
  return {
    threadId,
    threadName: `Thread ${threadId}`,
    participants: ['opus'],
    mode,
    messages: Array.from({ length: messageCount }, (_, i) => ({
      id: `${threadId}-msg-${i}`,
      type: 'assistant' as const,
      content: `Message ${i}`,
      catId: 'opus',
      timestamp: 1000 + i * 100,
      isStreaming: false as const,
    })),
  };
}

// ---------------------------------------------------------------------------
// MultiCamStage Tests
// ---------------------------------------------------------------------------

describe('MultiCamStage', () => {
  describe('single layout', () => {
    it('renders one panel with stage testid', () => {
      const html = renderToStaticMarkup(<MultiCamStage panels={[makePanel('t1', 'spotlight')]} layout="single" />);
      expect(html).toContain('data-testid="multicam-stage"');
      expect(html).toContain('data-testid="thread-panel-t1"');
    });

    it('does not render sidebar in single layout', () => {
      const html = renderToStaticMarkup(<MultiCamStage panels={[makePanel('t1', 'spotlight')]} layout="single" />);
      expect(html).not.toContain('data-testid="multicam-sidebar"');
    });
  });

  describe('dual layout', () => {
    it('renders two panels side by side', () => {
      const html = renderToStaticMarkup(
        <MultiCamStage panels={[makePanel('t1', 'spotlight'), makePanel('t2', 'active')]} layout="dual" />,
      );
      expect(html).toContain('data-testid="thread-panel-t1"');
      expect(html).toContain('data-testid="thread-panel-t2"');
      expect(html).toContain('grid-cols-2');
    });
  });

  describe('multi layout', () => {
    it('renders main area + sidebar for 3+ threads', () => {
      const html = renderToStaticMarkup(
        <MultiCamStage
          panels={[makePanel('t1', 'spotlight'), makePanel('t2', 'active'), makePanel('t3', 'dim')]}
          layout="multi"
        />,
      );
      expect(html).toContain('data-testid="multicam-sidebar"');
      expect(html).toContain('data-testid="multicam-main"');
    });

    it('sidebar contains overflow panels (t3, t4) while main has t1, t2', () => {
      const html = renderToStaticMarkup(
        <MultiCamStage
          panels={[
            makePanel('t1', 'spotlight'),
            makePanel('t2', 'active'),
            makePanel('t3', 'dim'),
            makePanel('t4', 'dim'),
          ]}
          layout="multi"
        />,
      );
      // Main panels (not inside sidebar)
      expect(html).toContain('data-testid="thread-panel-t1"');
      expect(html).toContain('data-testid="thread-panel-t2"');
      // Sidebar panels
      expect(html).toContain('data-testid="thread-panel-t3"');
      expect(html).toContain('data-testid="thread-panel-t4"');
    });
  });

  describe('empty state', () => {
    it('shows "No active threads" when panels is empty', () => {
      const html = renderToStaticMarkup(<MultiCamStage panels={[]} layout="single" />);
      expect(html).toContain('No active threads');
    });
  });
});

// ---------------------------------------------------------------------------
// ThreadPanel Visual State Tests
// ---------------------------------------------------------------------------

describe('ThreadPanel visual state', () => {
  it('applies spotlight mode attribute', () => {
    const html = renderToStaticMarkup(
      <MultiCamStage panels={[makePanel('t1', 'spotlight'), makePanel('t2', 'dim')]} layout="dual" />,
    );
    expect(html).toContain('data-panel-mode="spotlight"');
  });

  it('applies dim mode attribute', () => {
    const html = renderToStaticMarkup(
      <MultiCamStage panels={[makePanel('t1', 'spotlight'), makePanel('t2', 'dim')]} layout="dual" />,
    );
    expect(html).toContain('data-panel-mode="dim"');
  });

  it('applies active mode attribute', () => {
    const html = renderToStaticMarkup(
      <MultiCamStage panels={[makePanel('t1', 'spotlight'), makePanel('t2', 'active')]} layout="dual" />,
    );
    expect(html).toContain('data-panel-mode="active"');
  });

  it('renders thread name in each panel', () => {
    const html = renderToStaticMarkup(<MultiCamStage panels={[makePanel('t1', 'spotlight')]} layout="single" />);
    expect(html).toContain('Thread t1');
  });

  it('renders participant info', () => {
    const html = renderToStaticMarkup(<MultiCamStage panels={[makePanel('t1', 'spotlight')]} layout="single" />);
    expect(html).toContain('opus');
  });

  it('spotlight panel has purple glow box-shadow', () => {
    const html = renderToStaticMarkup(<MultiCamStage panels={[makePanel('t1', 'spotlight')]} layout="single" />);
    expect(html).toContain('rgba(168,85,247');
  });

  it('dim panel has reduced opacity', () => {
    const html = renderToStaticMarkup(
      <MultiCamStage panels={[makePanel('t1', 'spotlight'), makePanel('t2', 'dim')]} layout="dual" />,
    );
    expect(html).toContain('opacity:0.55');
  });

  it('dim panel shows Idle message when no messages', () => {
    const html = renderToStaticMarkup(
      <MultiCamStage panels={[makePanel('t1', 'spotlight'), makePanel('t2', 'dim', 0)]} layout="dual" />,
    );
    expect(html).toContain('Idle');
  });

  it('active panel shows "Waiting for events..." when no messages', () => {
    const html = renderToStaticMarkup(
      <MultiCamStage panels={[makePanel('t1', 'spotlight'), makePanel('t2', 'active', 0)]} layout="dual" />,
    );
    expect(html).toContain('Waiting for events...');
  });

  it('spotlight panel has animate-pulse activity indicator', () => {
    const html = renderToStaticMarkup(<MultiCamStage panels={[makePanel('t1', 'spotlight')]} layout="single" />);
    expect(html).toContain('animate-pulse');
  });

  it('dim panel disables pointer events on message area', () => {
    const html = renderToStaticMarkup(
      <MultiCamStage panels={[makePanel('t1', 'spotlight'), makePanel('t2', 'dim')]} layout="dual" />,
    );
    expect(html).toContain('pointer-events-none');
  });
});
