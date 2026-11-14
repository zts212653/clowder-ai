// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import postcss from 'postcss';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import tailwind from 'tailwindcss';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { LifecycleFlowDiagram } from '../../settings/LifecycleFlowDiagram';

const require = createRequire(import.meta.url);
const config = require('../../../../tailwind.config.js');
const postcssConfig = require('../../../../postcss.config.js');
const classes =
  'bg-[var(--console-card-bg)] bg-[var(--shell-paper)] bg-white dark:bg-cafe-surface hover:bg-cafe-accent';
let css: postcss.Root;

beforeAll(async () => {
  const legacy = readFileSync(require.resolve('../chat-background-surfaces.css'), 'utf8');
  const plugins = Object.entries(postcssConfig.plugins).map(([name, options]) =>
    name === 'tailwindcss'
      ? tailwind({ ...config, content: [{ raw: `<div class="${classes}"></div>` }] })
      : require(name)(options),
  );
  const result = await postcss(plugins).process(`@tailwind base; @tailwind utilities; ${legacy}`, {
    from: require.resolve('../../../app/globals.css'),
  });
  css = result.root;
});

function painted(element: Element): boolean {
  let result = false;
  css.walkRules((rule) => {
    if (
      !rule.nodes.some(
        (node) =>
          node.type === 'decl' && node.prop === 'background-image' && node.value.includes('--chat-background-image'),
      )
    )
      return;
    if (rule.selectors.some((selector) => element.matches(selector))) result = true;
  });
  return result;
}

function mount(markup: string) {
  document.documentElement.dataset.shell = 'v2';
  document.documentElement.dataset.chatBackground = 'image';
  document.documentElement.dataset.theme = 'light';
  document.body.innerHTML = markup;
  return document.querySelector('#subject')!;
}

it('a new ordinary card gets the viewport image from its shared surface utility without component registration', () => {
  const card = mount(
    '<div class="console-shell"><article id="subject" class="future-card bg-[var(--console-card-bg)]">New card</article></div>',
  );
  expect(painted(card)).toBe(true);
});

it('a faint hover tint on a working group does not turn its ordinary child cards into opaque controls', () => {
  const card = mount(
    '<div class="hover:bg-cafe-accent/[0.03]"><article id="subject" class="bg-[var(--console-card-bg)]">Project setup</article></div>',
  );
  expect(painted(card)).toBe(true);
});

it('the actual lifecycle diagram paints both section cards and its nested panel only in image mode', () => {
  mount('<div id="subject"></div>');
  document.body.innerHTML = renderToStaticMarkup(
    createElement(LifecycleFlowDiagram, {
      selectedStageId: null,
      onSelectStage: () => {},
      segmentCounts: {},
    }),
  );
  const sections = [...document.querySelectorAll('[data-chat-background-surface="console-card"]')];
  const panels = [...document.querySelectorAll('[data-chat-background-surface="console-panel"]')];
  expect(sections).toHaveLength(2);
  expect(panels).toHaveLength(1);
  for (const face of [...sections, ...panels]) expect(painted(face)).toBe(true);
  document.documentElement.dataset.chatBackground = 'none';
  for (const face of [...sections, ...panels]) expect(painted(face)).toBe(false);
});

it('native linked styles compile their shared surface declarations through the same global compositor', () => {
  const card = mount(
    '<div class="console-shell"><article id="subject" class="console-list-card">Native card</article></div>',
  );
  expect(painted(card)).toBe(true);
});

it.each([
  'cafe-world-rail',
  'cafe-header',
  'cafe-composer-surface',
])('shared native %s paint participates without component registration', (className) => {
  const face = mount(`<section id="subject" class="${className}">Working face</section>`);
  expect(painted(face)).toBe(true);
});

it('persistent working layers avoid entrance-animation paint caches only while an image is active', () => {
  const layer = mount(
    '<aside id="subject" class="future-working-layer" data-chat-background-layer="work">Inbox</aside>',
  );
  const stable = () => {
    let found = false;
    css.walkRules((rule) => {
      if (!rule.nodes.some((node) => node.type === 'decl' && node.prop === 'animation' && node.value === 'none'))
        return;
      if (rule.selectors.some((selector) => layer.matches(selector))) found = true;
    });
    return found;
  };
  expect(stable()).toBe(true);
  document.documentElement.dataset.chatBackground = 'none';
  expect(stable()).toBe(false);
});

it('an explicit surface role wins over a shared native component default', () => {
  const face = mount(
    '<section id="subject" class="console-status-panel" data-chat-background-surface="work">Workspace</section>',
  );
  const colours = new Set<string>();
  css.walkRules((rule) => {
    if (!rule.nodes.some((node) => node.type === 'decl' && node.prop === '--chat-background-surface')) return;
    if (!rule.selectors.some((selector) => face.matches(selector))) return;
    rule.walkDecls('--chat-background-surface', (decl) => {
      colours.add(decl.value);
    });
  });
  expect([...colours]).toEqual(['var(--shell-work)']);
});

it.each(['work', 'frame', 'paper'])('an explicitly owned %s surface is independent of its component name', (role) => {
  const face = mount(
    `<div class="console-shell"><section id="subject" data-chat-background-surface="${role}">Text</section></div>`,
  );
  expect(painted(face)).toBe(true);
});

it('a non-modal working drawer can paint outside the chat tree while keeping its dialog accessibility role', () => {
  const drawer = mount(
    '<div class="console-shell"></div><aside id="subject" role="dialog" data-chat-background-layer="work" data-chat-background-surface="work">Inbox</aside>',
  );
  expect(painted(drawer)).toBe(true);
});

it.each([
  'menu',
  'listbox',
  'dialog',
])('an actual %s and a shared card nested inside it retain opaque paint', (role) => {
  const card = mount(
    `<div class="console-shell"><section role="${role}"><article id="subject" class="bg-[var(--console-card-bg)]">Foreground</article></section></div>`,
  );
  expect(painted(card)).toBe(false);
});

it('a real dialog opened inside a working drawer is opaque', () => {
  const child = mount(
    '<aside role="dialog" data-chat-background-layer="work"><div role="dialog"><div id="subject" data-chat-background-surface="paper">Confirmation</div></div></aside>',
  );
  expect(painted(child)).toBe(false);
});

it('an explicitly opaque native content or control layer stops surface painting', () => {
  const card = mount(
    '<div class="console-shell"><div data-chat-background-layer="opaque"><div id="subject" data-chat-background-surface="paper">Original content</div></div></div>',
  );
  expect(painted(card)).toBe(false);
});

it('a neutral control that uses an emphasis fill on hover remains opaque', () => {
  const button = mount('<button id="subject" class="bg-[var(--console-card-bg)] hover:bg-cafe-accent">Save</button>');
  expect(painted(button)).toBe(false);
});

it.each([
  'select',
  'input type="checkbox"',
  'input type="radio"',
  'input type="color"',
  'input type="range"',
])('native %s controls retain their own paint and affordance', (tag) => {
  const control = mount(`<${tag} id="subject" data-chat-background-surface="paper">`);
  expect(painted(control)).toBe(false);
});

it('dark theme uses the declared dark surface instead of sampling a legacy light-only white role', () => {
  const card = mount('<article id="subject" class="bg-white dark:bg-cafe-surface">Card</article>');
  document.documentElement.dataset.theme = 'dark';
  expect(painted(card)).toBe(true);
  card.className = 'bg-white';
  expect(painted(card)).toBe(false);
});

it('classic and no-image modes keep the existing card paint', () => {
  const card = mount(
    '<div class="console-shell"><div id="subject" class="bg-[var(--console-card-bg)]">Card</div></div>',
  );
  document.documentElement.dataset.shell = 'classic';
  expect(painted(card)).toBe(false);
  document.documentElement.dataset.shell = 'v2';
  delete document.documentElement.dataset.chatBackground;
  expect(painted(card)).toBe(false);
});

afterEach(() => {
  delete document.documentElement.dataset.shell;
  delete document.documentElement.dataset.chatBackground;
  document.body.innerHTML = '';
  delete document.documentElement.dataset.theme;
});
