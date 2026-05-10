import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useIMEGuard', () => ({
  useIMEGuard: () => ({ onCompositionStart: () => {}, onCompositionEnd: () => {}, isComposing: () => false }),
}));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ synthesize: vi.fn(), state: 'idle' }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: ({ catId, size }: { catId: string; size: number }) =>
    React.createElement('div', { 'data-testid': `avatar-${catId}`, style: { width: size } }),
}));

vi.mock('@/stores/brakeStore', () => ({
  useBrakeStore: () => ({
    visible: true,
    level: 1 as const,
    activeMinutes: 60,
    nightMode: false,
    submitting: false,
    checkin: vi.fn(),
    bypassDisabled: false,
  }),
}));

import { BrakeModal } from '@/components/BrakeModal';

describe('BrakeModal theme compliance', () => {
  it('uses theme card-bg as modal panel background, not alert colors', () => {
    const html = renderToStaticMarkup(React.createElement(BrakeModal));
    expect(html).toContain('--console-card-bg');
    const panelMatch = html.match(/rounded-2xl shadow-2xl[^"]*"/);
    expect(panelMatch).toBeTruthy();
    const panelClasses = panelMatch![0];
    expect(panelClasses).not.toContain('bg-conn-amber-bg');
    expect(panelClasses).not.toContain('bg-conn-red-bg');
    expect(panelClasses).not.toContain('bg-conn-sky-bg');
  });

  it('uses shadow-only design without visible borders', () => {
    const html = renderToStaticMarkup(React.createElement(BrakeModal));
    expect(html).toContain('shadow-2xl');
    expect(html).not.toContain('border-2');
  });
});
