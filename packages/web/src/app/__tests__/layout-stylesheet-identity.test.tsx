// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React, { Children, isValidElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import RootLayout from '../layout';

// The actual document head is the consumer under test; the body does not run.
vi.mock('@/components/AppShell', () => ({ AppShell: () => null }));
vi.mock('@/components/BrakeModal', () => ({ BrakeModal: () => null }));
vi.mock('@/components/CatHueInjector', () => ({ CatHueInjector: () => null }));
vi.mock('@/components/CoCreatorHueInjector', () => ({ CoCreatorHueInjector: () => null }));
vi.mock('@/components/GuideOverlay', () => ({ GuideOverlay: () => null }));
vi.mock('@/components/SessionBootstrap', () => ({ SessionBootstrap: () => null }));
vi.mock('@/components/ThemeApplier', () => ({ ThemeApplier: () => null }));
vi.mock('@/components/ThemeProvider', () => ({ ThemeProvider: () => null }));
vi.mock('@/components/ToastContainer', () => ({ ToastContainer: () => null }));
vi.mock('@/components/useConfirm', () => ({ ConfirmProvider: () => null }));

Object.assign(globalThis, { React });

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/sync-vendor-assets.mjs'], { stdio: 'pipe' });
});

describe('the document references immutable versions of its static stylesheets', () => {
  it('binds every emitted stylesheet URL to the published bytes', () => {
    const root = RootLayout({ children: null });
    const head = Children.toArray(root.props.children).find(
      (element) => isValidElement(element) && element.type === 'head',
    );
    expect(isValidElement<{ children: React.ReactNode }>(head)).toBe(true);
    if (!isValidElement<{ children: React.ReactNode }>(head)) throw new Error('Missing document head');
    const stylesheets = Children.toArray(head.props.children).filter(
      (element) => isValidElement<{ rel: string }>(element) && element.props.rel === 'stylesheet',
    );
    expect(stylesheets).toHaveLength(10);
    const unversionedUrls: string[] = [];
    for (const stylesheet of stylesheets) {
      if (!isValidElement<{ href: string }>(stylesheet)) throw new Error('Invalid stylesheet element');
      const href = stylesheet.props.href;
      unversionedUrls.push(href.replace(/\.[a-f0-9]{16}\.css$/, '.css'));
      const bytes = readFileSync(path.join(process.cwd(), 'public', href));
      const fingerprint = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      expect(href, 'A previous worker must not match this document against a different stylesheet version').toMatch(
        new RegExp(`\\.${fingerprint}\\.css$`),
      );
    }
    expect(unversionedUrls).toEqual([
      '/vendor/app/theme-tokens.css',
      '/vendor/app/cat-persona-tokens.css',
      '/vendor/app/cat-persona-derived.css',
      '/vendor/app/connector-tokens.css',
      '/vendor/app/theme-extras.css',
      '/vendor/app/console-tokens.css',
      '/vendor/app/console-shell.css',
      '/vendor/app/console-controls.css',
      '/vendor/app/shell-v2.css',
      '/vendor/xterm/xterm.css',
    ]);
  });
});
