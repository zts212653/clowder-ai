import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConsoleEntry } from '../ConsolePanel';
import { ConsolePanel } from '../ConsolePanel';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('ConsolePanel', () => {
  const entries: ConsoleEntry[] = [
    { level: 'log', args: ['hello world'], timestamp: 1000 },
    { level: 'warn', args: ['be careful'], timestamp: 2000 },
    { level: 'error', args: ['something broke'], timestamp: 3000 },
  ];

  it('renders console entries with level indicators', () => {
    const html = renderToStaticMarkup(<ConsolePanel entries={entries} onClear={() => {}} />);
    expect(html).toContain('hello world');
    expect(html).toContain('be careful');
    expect(html).toContain('something broke');
  });

  it('shows entry count', () => {
    const html = renderToStaticMarkup(<ConsolePanel entries={entries} onClear={() => {}} />);
    expect(html).toContain('3');
  });

  it('shows empty state when no entries', () => {
    const html = renderToStaticMarkup(<ConsolePanel entries={[]} onClear={() => {}} />);
    expect(html).toContain('No console output');
  });

  it('renders level-specific colors', () => {
    const html = renderToStaticMarkup(<ConsolePanel entries={entries} onClear={() => {}} />);
    // Error entries should have red styling
    expect(html).toContain('text-red');
    // Warn entries should have amber/yellow styling
    expect(html).toContain('text-amber');
  });
});
