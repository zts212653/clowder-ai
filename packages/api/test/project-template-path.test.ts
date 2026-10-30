import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { isWithinProjectRoot, resolveProjectTemplatePath } from '../src/config/project-template-path.js';

test('project template selection accepts descendants and rejects sibling prefixes', () => {
  const root = resolve('template-root');
  assert.equal(isWithinProjectRoot(root, root), true);
  assert.equal(isWithinProjectRoot(root, join(root, 'nested', 'template.json')), true);
  assert.equal(isWithinProjectRoot(root, resolve('template-root-other', 'template.json')), false);
});

test(
  'Windows cross-drive and cross-share paths cannot redirect a project template',
  { skip: process.platform !== 'win32' },
  (t) => {
    const previous = process.env.CAT_TEMPLATE_PATH;
    t.after(() => {
      if (previous === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previous;
    });
    for (const [root, other] of [
      ['C:\\project', 'D:\\shared\\cat-template.json'],
      ['\\\\server-a\\share\\project', '\\\\server-b\\share\\cat-template.json'],
    ]) {
      process.env.CAT_TEMPLATE_PATH = other;
      assert.equal(isWithinProjectRoot(root, other), false);
      assert.equal(resolveProjectTemplatePath(root), resolve(root, 'cat-template.json'));
    }
  },
);
