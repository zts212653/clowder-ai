import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preserveInteractiveBlockStates } from '../dist/interactive-block-state.js';

const question = {
  id: 'question',
  kind: 'interactive',
  v: 1,
  interactiveType: 'select',
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
};
const answered = { ...question, disabled: true, selectedIds: ['a'] };

test('replayed questions preserve compatible saved answers even when option order changes', () => {
  const [merged] = preserveInteractiveBlockStates(
    [{ ...question, options: [...question.options].reverse() }],
    [answered],
  );
  assert.equal(merged.disabled, true);
  assert.deepEqual(merged.selectedIds, ['a']);
  assert.deepEqual(
    merged.options.map((option) => option.id),
    ['b', 'a'],
  );
});

test('a revised question or a non-interactive block does not inherit a saved answer', () => {
  const changed = [
    { ...question, id: 'different' },
    { ...question, interactiveType: 'multi-select' },
    { ...question, options: [{ id: 'c', label: 'C' }] },
    { id: question.id, kind: 'text', v: 1, text: 'Other content' },
  ];
  assert.deepEqual(preserveInteractiveBlockStates(changed, [answered]), changed);
});
