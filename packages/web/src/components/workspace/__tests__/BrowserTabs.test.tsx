import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BrowserTab } from '../BrowserPanel';
import { BrowserTabBar } from '../BrowserTabBar';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('BrowserTabBar', () => {
  const tabs: BrowserTab[] = [
    { id: 'a', port: 5173, path: '/', title: 'localhost:5173' },
    { id: 'b', port: 3000, path: '/api', title: 'localhost:3000/api' },
  ];

  it('renders tab titles', () => {
    const html = renderToStaticMarkup(
      <BrowserTabBar tabs={tabs} activeTabId="a" onSelect={() => {}} onClose={() => {}} onAdd={() => {}} />,
    );
    expect(html).toContain('localhost:5173');
    expect(html).toContain('localhost:3000/api');
  });

  it('highlights active tab', () => {
    const html = renderToStaticMarkup(
      <BrowserTabBar tabs={tabs} activeTabId="a" onSelect={() => {}} onClose={() => {}} onAdd={() => {}} />,
    );
    // Active tab has a distinctive background
    expect(html).toContain('bg-[#FDF8F3]');
  });

  it('renders add button', () => {
    const html = renderToStaticMarkup(
      <BrowserTabBar tabs={tabs} activeTabId="a" onSelect={() => {}} onClose={() => {}} onAdd={() => {}} />,
    );
    expect(html).toContain('+');
  });

  it('renders close buttons for each tab', () => {
    const html = renderToStaticMarkup(
      <BrowserTabBar tabs={tabs} activeTabId="a" onSelect={() => {}} onClose={() => {}} onAdd={() => {}} />,
    );
    // Two close buttons (×)
    const closeCount = (html.match(/×/g) || []).length;
    expect(closeCount).toBe(2);
  });
});
