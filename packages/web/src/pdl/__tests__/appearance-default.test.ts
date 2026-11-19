import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it } from 'vitest';

function themeDocs(saved: unknown) {
  // The engine declares these before the app scripts run.
  const context = createContext({
    A: {},
    THEME_DOCS: null,
    THEME_PACKS: null,
    api: { get: async () => ({ themes: saved }) },
  });
  runInContext(readFileSync('public/pdl-app/appearance.js', 'utf8'), context);
  return runInContext('THEME_DOCS', context) as { read: () => Promise<unknown> };
}

it('starts on the v2 package when the owner has not saved a theme yet', async () => {
  expect(await themeDocs(null).read()).toEqual({ active: 'pkg:v2', customs: [] });
});

it('keeps a saved theme choice as it is', async () => {
  const saved = { active: 'sys:1', customs: [] };
  expect(await themeDocs(saved).read()).toEqual(saved);
});
