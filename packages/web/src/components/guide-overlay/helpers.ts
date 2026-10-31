'use client';

import type React from 'react';

export interface ShieldPanels {
  top: { height: number };
  bottom: { top: number };
  left: { top: number; width: number; height: number };
  right: { top: number; left: number; height: number };
}

export function computeHUDPosition(
  targetRect: DOMRect | null,
  hudSize: { width?: number; height?: number } = {},
): React.CSSProperties {
  if (!targetRect) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }

  const hudWidth = hudSize.width ?? 280;
  const hudHeight = hudSize.height ?? 160;
  const gap = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = targetRect.bottom + gap;
  let left = targetRect.left + targetRect.width / 2 - hudWidth / 2;

  if (top + hudHeight > vh - gap) {
    top = targetRect.top - hudHeight - gap;
  }
  left = Math.max(gap, Math.min(left, vw - hudWidth - gap));
  top = Math.max(gap, top);
  return { top, left };
}

export function computeShieldPanels(
  rect: { top: number; bottom: number; left: number; right: number; width: number; height: number },
  pad: number,
): ShieldPanels {
  const h = rect.height + pad * 2;
  return {
    top: { height: Math.max(0, rect.top - pad) },
    bottom: { top: rect.bottom + pad },
    left: { top: rect.top - pad, width: Math.max(0, rect.left - pad), height: h },
    right: { top: rect.top - pad, left: rect.right + pad, height: h },
  };
}

export function buildGuideTargetSelector(target: string): string {
  const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(target) : target;
  return `[data-guide-id="${escaped}"]`;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
].join(', ');

export function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];

  const elements = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('inert'),
  );
  if (root.matches(FOCUSABLE_SELECTOR) && !root.hasAttribute('inert')) {
    elements.unshift(root);
  }
  return elements;
}
