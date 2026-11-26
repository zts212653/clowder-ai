import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync('public/pdl/engine/anchor.js', 'utf8');
const target = '<span id="target">Right-click here</span>';
const trigger = '<button data-menu-decl data-menu="more">More</button>';

it.each([
  {
    name: 'keeps a theme card from opening the settings page header menu',
    html: `<main data-view="page.theme"><header>${trigger}</header><section>${target}</section></main>`,
    menus: [],
  },
  {
    name: 'keeps a theme card from opening a covered conversation menu',
    html: `<main data-layer="outer"><div data-layer="settings">${target}</div><div inert>${trigger}</div></main>`,
    menus: [],
  },
  {
    name: 'opens a menu from its own conversation row',
    html: `<main data-layer="chat"><div data-tid="thread">${target}${trigger}</div></main>`,
    menus: ['more'],
  },
  {
    name: 'opens a header menu from the header itself',
    html: `<main data-view="page.theme"><header>${target}${trigger}</header></main>`,
    menus: ['more'],
  },
])('$name', ({ html, menus }) => {
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = html;
  const menu = vi.fn<(args: DOMStringMap) => void>();
  runInNewContext(source, {
    document: doc,
    treeIn() {},
    treeFlush() {},
    onRender() {},
    nodeId: () => null,
    CSS: { escape: (name: string) => name },
    ACT_FROM: null,
    S: { popOrder: [] },
    A: { menu },
    actionArgs: (element: HTMLElement) => element.dataset,
  });

  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  const clicked = doc.getElementById('target');
  expect(clicked).not.toBeNull();
  clicked?.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(menus.length > 0);
  expect(menu.mock.calls.map(([args]) => args.menu)).toEqual(menus);
});
