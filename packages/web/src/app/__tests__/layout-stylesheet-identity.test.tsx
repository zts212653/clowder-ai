// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import RootLayout from '../layout';

Object.assign(globalThis, { React });
it('leaves the console document styling to its loaded PDL assets', () => {
  const html = renderToStaticMarkup(RootLayout({ children: <div id="console" /> }));
  expect(html).not.toContain('rel="stylesheet"');
  expect(html).not.toContain('style=');
  expect(html).not.toContain('data-shell=');
  expect(html).toContain('id="console"');
});
