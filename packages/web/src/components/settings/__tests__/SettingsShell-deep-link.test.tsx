import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('../SettingsContent', () => ({
  SettingsContent: (props: { section: string }) => <div data-testid="settings-content" data-section={props.section} />,
}));

vi.mock('../SettingsNav', () => ({
  SettingsNav: (props: { activeSection: string }) => (
    <nav data-testid="settings-nav" data-active={props.activeSection} />
  ),
}));

import { SettingsShell } from '../SettingsShell';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('SettingsShell deep-link routing', () => {
  it('opens the ops section when an ops deep-link omits s=ops', () => {
    mockSearchParams = new URLSearchParams('ops=observability&obs=eval');

    const html = renderToStaticMarkup(<SettingsShell />);

    expect(html).toContain('data-section="ops"');
    expect(html).toContain('data-active="ops"');
  });

  it('keeps an explicit settings section when s is present', () => {
    mockSearchParams = new URLSearchParams('s=members&ops=observability&obs=eval');

    const html = renderToStaticMarkup(<SettingsShell />);

    expect(html).toContain('data-section="members"');
    expect(html).toContain('data-active="members"');
  });
});
