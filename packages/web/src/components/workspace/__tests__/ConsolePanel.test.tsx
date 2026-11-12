import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShellPresentationContext } from '@/components/shell/shell-presentation';
import type { ConsoleEntry } from '../ConsolePanel';
import { ConsolePanel } from '../ConsolePanel';

Object.assign(globalThis as Record<string, unknown>, { React });

// These cases protect the explicitly selected classic interface, independently of the new-visit default.
function renderClassic(element: React.ReactNode) {
  return renderToStaticMarkup(
    <ShellPresentationContext.Provider value="classic">{element}</ShellPresentationContext.Provider>,
  );
}

describe('ConsolePanel', () => {
  const entries: ConsoleEntry[] = [
    { level: 'log', args: ['hello world'], timestamp: 1000 },
    { level: 'warn', args: ['be careful'], timestamp: 2000 },
    { level: 'error', args: ['something broke'], timestamp: 3000 },
  ];

  it('renders console entries with level indicators', () => {
    const html = renderClassic(<ConsolePanel entries={entries} onClear={() => {}} />);
    expect(html).toContain('hello world');
    expect(html).toContain('be careful');
    expect(html).toContain('something broke');
  });

  it('shows entry count', () => {
    const html = renderClassic(<ConsolePanel entries={entries} onClear={() => {}} />);
    expect(html).toContain('3');
  });

  it('shows empty state when no entries', () => {
    const html = renderClassic(<ConsolePanel entries={[]} onClear={() => {}} />);
    expect(html).toContain('No console output');
  });

  it('renders level-specific colors', () => {
    const html = renderClassic(<ConsolePanel entries={entries} onClear={() => {}} />);
    // Error entries should have red styling
    expect(html).toContain('text-conn-red-text');
    // Warn entries should have amber/yellow styling
    expect(html).toContain('text-conn-amber-text');
  });
});
