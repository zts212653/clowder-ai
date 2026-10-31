'use client';

import type React from 'react';
import { computeShieldPanels } from './helpers';

interface GuideOverlaySpotlightProps {
  targetRect: DOMRect | null;
  pad?: number;
}

export function GuideOverlaySpotlight({ targetRect, pad = 8 }: GuideOverlaySpotlightProps) {
  const cutoutStyle: React.CSSProperties = targetRect
    ? {
        position: 'fixed',
        top: targetRect.top - pad,
        left: targetRect.left - pad,
        width: targetRect.width + pad * 2,
        height: targetRect.height + pad * 2,
        borderRadius: 'var(--guide-radius)',
        boxShadow: '0 0 0 9999px var(--guide-overlay-bg)',
        transition: 'all var(--guide-transition-duration) ease-out',
        zIndex: 'var(--guide-z-overlay)' as unknown as number,
        pointerEvents: 'none' as const,
      }
    : {
        position: 'fixed',
        inset: 0,
        backgroundColor: 'var(--guide-overlay-bg)',
        zIndex: 'var(--guide-z-overlay)' as unknown as number,
        pointerEvents: 'none' as const,
      };

  const ringStyle: React.CSSProperties = targetRect
    ? {
        position: 'fixed',
        top: targetRect.top - pad - 2,
        left: targetRect.left - pad - 2,
        width: targetRect.width + pad * 2 + 4,
        height: targetRect.height + pad * 2 + 4,
        borderRadius: 'var(--guide-radius)',
        border: '2px solid var(--guide-cutout-ring)',
        boxShadow: '0 0 12px var(--guide-cutout-shadow), inset 0 0 8px var(--guide-cutout-shadow)',
        transition: 'all var(--guide-transition-duration) ease-out',
        zIndex: 1105,
        pointerEvents: 'none' as const,
        animation: 'var(--guide-breathe-animation)',
      }
    : {};

  const shieldZ = 1101;
  const panels = targetRect ? computeShieldPanels(targetRect, pad) : null;

  return (
    <>
      <div style={cutoutStyle} aria-hidden="true" />
      {targetRect && <div style={ringStyle} aria-hidden="true" />}
      {panels ? (
        <>
          <div
            data-guide-click-shield="panel"
            className="fixed top-0 left-0 right-0"
            style={{ height: panels.top.height, zIndex: shieldZ, pointerEvents: 'auto' }}
            aria-hidden="true"
          />
          <div
            data-guide-click-shield="panel"
            className="fixed bottom-0 left-0 right-0"
            style={{ top: panels.bottom.top, zIndex: shieldZ, pointerEvents: 'auto' }}
            aria-hidden="true"
          />
          <div
            data-guide-click-shield="panel"
            className="fixed"
            style={{
              top: panels.left.top,
              left: 0,
              width: panels.left.width,
              height: panels.left.height,
              zIndex: shieldZ,
              pointerEvents: 'auto',
            }}
            aria-hidden="true"
          />
          <div
            data-guide-click-shield="panel"
            className="fixed"
            style={{
              top: panels.right.top,
              left: panels.right.left,
              right: 0,
              height: panels.right.height,
              zIndex: shieldZ,
              pointerEvents: 'auto',
            }}
            aria-hidden="true"
          />
        </>
      ) : (
        <div
          data-guide-click-shield="fallback"
          className="fixed inset-0"
          style={{ zIndex: shieldZ, pointerEvents: 'none' }}
          aria-hidden="true"
        />
      )}
    </>
  );
}
