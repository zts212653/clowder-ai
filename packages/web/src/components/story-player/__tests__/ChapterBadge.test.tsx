/**
 * F252 Phase E PR E-3 — ChapterBadge Component Tests
 *
 * Tests the milestone badge rendering: kind-based styling,
 * hover tooltip with label + relative time, click handler.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChapterBadge } from '../ChapterBadge';

// ---------------------------------------------------------------------------
// DOM setup (jsdom, matching project pattern)
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChapterBadge', () => {
  const baseProps = {
    kind: 'pass_ball' as const,
    label: '→ @codex',
    icon: '🏐',
    position: 50,
    isPast: true,
    relativeTime: '2:30',
    onClick: vi.fn(),
  };

  it('renders badge button with correct aria-label', () => {
    act(() => root.render(<ChapterBadge {...baseProps} />));

    const badge = container.querySelector('button[aria-label="→ @codex"]');
    expect(badge).not.toBeNull();
  });

  it('positions badge at correct percentage', () => {
    act(() => root.render(<ChapterBadge {...baseProps} position={75} />));

    const badge = container.querySelector('button') as HTMLButtonElement;
    expect(badge.style.left).toBe('75%');
  });

  it('applies data-chapter-kind attribute for pass_ball', () => {
    act(() => root.render(<ChapterBadge {...baseProps} />));

    const badge = container.querySelector('[data-chapter-kind="pass_ball"]');
    expect(badge).not.toBeNull();
  });

  it('applies data-chapter-kind attribute for invocation', () => {
    act(() => root.render(<ChapterBadge {...baseProps} kind="invocation" icon="🔄" />));

    const badge = container.querySelector('[data-chapter-kind="invocation"]');
    expect(badge).not.toBeNull();
  });

  it('applies data-chapter-kind attribute for post_idle', () => {
    act(() => root.render(<ChapterBadge {...baseProps} kind="post_idle" icon="⏩" />));

    const badge = container.querySelector('[data-chapter-kind="post_idle"]');
    expect(badge).not.toBeNull();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    act(() => root.render(<ChapterBadge {...baseProps} onClick={onClick} />));

    const badge = container.querySelector('button') as HTMLButtonElement;
    act(() => badge.click());

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows tooltip on mouseenter and hides on mouseleave', () => {
    act(() => root.render(<ChapterBadge {...baseProps} />));

    // No tooltip initially
    expect(container.querySelector('[role="tooltip"]')).toBeNull();

    // React 18 onMouseEnter fires from 'mouseover' in jsdom
    const badge = container.querySelector('button') as HTMLButtonElement;
    act(() => {
      badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const tooltip = container.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent).toContain('→ @codex');
    expect(tooltip!.textContent).toContain('at 2:30');

    // Mouse leave — React fires from 'mouseout'
    act(() => {
      badge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('renders icon inside badge', () => {
    act(() => root.render(<ChapterBadge {...baseProps} />));

    const badge = container.querySelector('button') as HTMLButtonElement;
    expect(badge.textContent).toContain('🏐');
  });
});
