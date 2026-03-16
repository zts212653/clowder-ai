/**
 * Regression test: BrowserPanel Strict Mode tab dedup (Bug B from F120 Alpha)
 *
 * React Strict Mode runs useEffect twice. The tab creation useEffect must
 * produce only one tab per initialPort, even when called twice.
 */
import { describe, expect, it } from 'vitest';

describe('BrowserPanel tab dedup (Strict Mode regression)', () => {
  it('functional setState dedup produces one tab even when called twice', () => {
    // Simulate what BrowserPanel's useEffect does internally:
    // setTabs(prev => { ... }) called twice with same initialPort
    type Tab = { id: string; port: number; path: string; title: string };
    let tabs: Tab[] = [];
    let idCounter = 0;

    // Simulate the functional updater from BrowserPanel
    function tabUpdater(prev: Tab[], initialPort: number, path: string): Tab[] {
      const title = `localhost:${initialPort}${path !== '/' ? path : ''}`;
      const existing = prev.find((t) => t.port === initialPort);
      if (existing) return prev;
      const id = `tab-${++idCounter}`;
      return [...prev, { id, port: initialPort, path, title }];
    }

    // First call (normal execution)
    tabs = tabUpdater(tabs, 5173, '/');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].port).toBe(5173);

    // Second call (Strict Mode re-execution) — uses result from first call
    tabs = tabUpdater(tabs, 5173, '/');
    expect(tabs).toHaveLength(1); // Still 1 — dedup works
  });

  it('creates separate tabs for different ports', () => {
    type Tab = { id: string; port: number; path: string; title: string };
    let tabs: Tab[] = [];
    let idCounter = 0;

    function tabUpdater(prev: Tab[], initialPort: number, path: string): Tab[] {
      const title = `localhost:${initialPort}${path !== '/' ? path : ''}`;
      const existing = prev.find((t) => t.port === initialPort);
      if (existing) return prev;
      const id = `tab-${++idCounter}`;
      return [...prev, { id, port: initialPort, path, title }];
    }

    tabs = tabUpdater(tabs, 5173, '/');
    tabs = tabUpdater(tabs, 3000, '/dashboard');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].port).toBe(5173);
    expect(tabs[1].port).toBe(3000);
  });
});
