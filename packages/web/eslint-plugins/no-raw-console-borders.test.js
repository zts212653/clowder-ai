const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { RuleTester } = require('eslint');
const rule = require('./no-raw-console-borders');

const missingScopePaths = rule.scopedComponentPaths.filter(
  (componentPath) => !existsSync(path.join(__dirname, '../src/components', componentPath)),
);
assert.deepEqual(missingScopePaths, [], 'Update the border policy scope when its components move or are removed');

const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2020, ecmaFeatures: { jsx: true }, sourceType: 'module' },
});
const divider = '/repo/packages/web/src/components/memory/MemoryNav.tsx';
const card = '/repo/packages/web/src/components/mission-control/MissionControlCard.tsx';

tester.run('no-raw-console-borders', rule, {
  valid: [
    { filename: divider, code: '<nav className="console-divider-b" />' },
    { filename: card, code: '<div className="console-list-card" />' },
    { filename: divider, code: '// border-b border-[var(--console-border-soft)]\nconst note = "unrelated";' },
    { filename: divider, code: '<input className="border border-[var(--console-border-soft)]" />' },
    { filename: card, code: 'const data = "border border-[var(--console-border-soft)]";' },
    {
      filename: '/repo/packages/web/src/components/OtherCard.tsx',
      code: '<div className="border border-[var(--console-border-soft)] border-b border-[var(--console-border-soft)]" />',
    },
  ],
  invalid: [
    {
      filename: divider,
      code: '<nav className="border-b border-[var(--console-border-soft)]" />',
      errors: [{ messageId: 'divider' }],
    },
    {
      filename: divider,
      code: 'const dividerClass = "border-r border-[var(--console-border-soft)]";',
      errors: [{ messageId: 'divider' }],
    },
    {
      filename: divider,
      code: '<nav className={`px-4 border-t border-[var(--console-border-soft)] ${active}`} />',
      errors: [{ messageId: 'divider' }],
    },
    {
      filename: card,
      code: '<div className="p-2 border border-[var(--console-border-soft)]" />',
      errors: [{ messageId: 'card' }],
    },
  ],
});
